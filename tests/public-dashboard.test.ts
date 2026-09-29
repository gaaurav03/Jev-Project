import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import type { CloudRun } from '../src/cloud.js';
import {
  listCloudRuns,
  readCloudRuns,
  summarizeCloudRuns,
} from '../src/public-dashboard.js';

const rows: CloudRun[] = [
  {
    id: 'run-private1111', record_version: 1, run_at: '2026-01-03T12:00:00.000Z',
    source: 'live', mode: 'local', status: 'applied', fallback_reason: null,
    estimated_tokens_before: 100, estimated_tokens_after: 80,
    estimated_tokens_saved: 20, estimated_reduction: 0.2, latency_ms: 5,
    request_count: 0, input_tokens: null, output_tokens: null, known_cost_usd: null,
    critical_required: null, critical_retained: null, task_passed: null,
    kept_count: 2, truncated_count: 0, removed_count: 1,
  },
  {
    id: 'run-private2222', record_version: 1, run_at: '2026-01-02T12:00:00.000Z',
    source: 'benchmark', mode: 'jev', status: 'passed', fallback_reason: null,
    estimated_tokens_before: 100, estimated_tokens_after: 60,
    estimated_tokens_saved: 40, estimated_reduction: 0.4, latency_ms: 10,
    request_count: 1, input_tokens: 100, output_tokens: 20, known_cost_usd: 0.01,
    critical_required: 2, critical_retained: 2, task_passed: true,
    kept_count: 1, truncated_count: 1, removed_count: 1,
  },
  {
    id: 'run-private3333', record_version: 1, run_at: '2026-01-01T12:00:00.000Z',
    source: 'live', mode: 'jev', status: 'fallback', fallback_reason: 'remote_error',
    estimated_tokens_before: null, estimated_tokens_after: null,
    estimated_tokens_saved: null, estimated_reduction: null, latency_ms: null,
    request_count: null, input_tokens: null, output_tokens: null, known_cost_usd: null,
    critical_required: null, critical_retained: null, task_passed: null,
    kept_count: 0, truncated_count: 0, removed_count: 0,
  },
];

describe('public dashboard data', () => {
  it('returns aggregates and recent metrics without private run identifiers', () => {
    const summary = summarizeCloudRuns(rows);
    expect(summary).toMatchObject({
      scope: 'public',
      totalRuns: 3,
      cards: {
        estimatedTokensSaved: 60,
        criticalRetention: 1,
        taskPassRate: 1,
        requests: 1,
      },
      comparison: {
        jev: { runs: 2, estimatedTokensSaved: 40 },
        local: { runs: 1, estimatedTokensSaved: 20 },
      },
    });
    expect(summary.cards.averageReduction).toBeCloseTo(0.3);
    expect(JSON.stringify(summary)).not.toMatch(/run-private|decisions|benchmark.*caseId|tool/);
    expect(summary.trends.every((trend) => !('id' in trend))).toBe(true);

    const listed = listCloudRuns(
      rows,
      new URL('https://dashboard.local/api/runs?mode=local&status=applied&limit=1'),
    );
    expect(listed).toMatchObject({
      returned: 1,
      available: 1,
      limit: 1,
      runs: [{
        timestamp: '2026-01-03T12:00:00.000Z',
        mode: 'local',
        status: 'applied',
        decisionCounts: { kept: 2, truncated: 0, removed: 1 },
      }],
    });
    expect(JSON.stringify(listed)).not.toMatch(/run-private|fallbackReason|benchmark|decisions|tool/);
  });

  it('reads only bounded, explicitly selected Supabase rows with the server key', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(rows) }));
    const result = await readCloudRuns(
      {
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
      },
      fetcher,
    );
    expect(result).toEqual(rows);
    const [url, init] = fetcher.mock.calls[0]!;
    const endpoint = new URL(url);
    expect(endpoint.origin + endpoint.pathname).toBe(
      'https://project.supabase.co/rest/v1/compaction_runs',
    );
    expect(endpoint.searchParams.get('limit')).toBe('1000');
    expect(endpoint.searchParams.get('order')).toBe('run_at.desc');
    expect(endpoint.searchParams.get('select')).not.toContain('received_at');
    expect(init.headers).toEqual({
      apikey: 'server-only-key',
      authorization: 'Bearer server-only-key',
    });

    await expect(readCloudRuns(
      {
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
      },
      async () => { throw new Error('database secret leaked'); },
    )).rejects.toThrow('Cloud metrics unavailable');
  });

  it('configures a static Vercel dashboard with security headers and bounded refresh', async () => {
    const config = JSON.parse(await readFile('vercel.json', 'utf8')) as {
      outputDirectory: string;
      headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    };
    expect(config.outputDirectory).toBe('dashboard');
    const headers = Object.fromEntries(config.headers[0]!.headers.map(({ key, value }) => [key, value]));
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('no-referrer');

    const script = await readFile('dashboard/dashboard.js', 'utf8');
    expect(script).toContain('window.setInterval');
    expect(script).toContain('30_000');
    expect(script).toContain("typeof run.id === 'string'");
    expect(script).not.toContain('innerHTML');
  });
});