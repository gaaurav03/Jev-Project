import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  startDashboardServer,
  type RunMetrics,
  type RunRecord,
} from '../src/index.js';

function metrics(
  saved: number,
  reduction: number,
  latencyMs: number,
  benchmark: { retained: number; passed: boolean } | null,
): RunMetrics {
  return {
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 100 - saved,
    estimatedTokensSaved: saved,
    estimatedReduction: reduction,
    latencyMs,
    requests: saved === 40 ? 1 : 0,
    apiUsage: saved === 40 ? { inputTokens: 100, outputTokens: 20 } : null,
    costUsd: saved === 40 ? 0.01 : null,
    criticalRetention: benchmark
      ? { required: 2, retained: benchmark.retained, ratio: benchmark.retained / 2 }
      : null,
    taskPassed: benchmark?.passed ?? null,
  };
}

const records: RunRecord[] = [
  {
    version: 1,
    id: 'run-aaaa1111',
    timestamp: '2026-01-01T12:00:00.000Z',
    source: 'benchmark',
    mode: 'jev',
    status: 'passed',
    fallbackReason: null,
    metrics: metrics(40, 0.4, 10, { retained: 2, passed: true }),
    decisions: [
      { id: 't1', tool: 'Read', action: 'drop_call', reason: 'call_dropped', keepCall: 0, keepResult: 0 },
    ],
    benchmark: { caseId: 'jev-case', category: 'obsolete-read' },
  },
  {
    version: 1,
    id: 'run-bbbb2222',
    timestamp: '2026-01-02T12:00:00.000Z',
    source: 'benchmark',
    mode: 'local',
    status: 'failed',
    fallbackReason: null,
    metrics: metrics(20, 0.2, 5, { retained: 1, passed: false }),
    decisions: [],
    benchmark: { caseId: 'local-case', category: 'required-error' },
  },
  {
    version: 1,
    id: 'run-cccc3333',
    timestamp: '2026-01-03T12:00:00.000Z',
    source: 'live',
    mode: 'local',
    status: 'applied',
    fallbackReason: null,
    metrics: metrics(30, 0.3, 2, null),
    decisions: [],
    benchmark: null,
  },
  {
    version: 1,
    id: 'run-dddd4444',
    timestamp: '2026-01-04T12:00:00.000Z',
    source: 'live',
    mode: 'jev',
    status: 'fallback',
    fallbackReason: 'remote_error',
    metrics: null,
    decisions: [],
    benchmark: null,
  },
];

describe('dashboard API', () => {
  it('serves secure summaries, filtered runs, and safe details on localhost', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jev-dashboard-'));
    const historyPath = join(directory, 'runs.jsonl');
    await appendFile(
      historyPath,
      records.map((record, index) => JSON.stringify(index === 0
        ? { ...record, prompt: 'secret prompt', rawToolOutput: 'secret output' }
        : record)).join('\n') + '\n{malformed}\n',
      'utf8',
    );
    const server = await startDashboardServer({ historyPath, port: 0 });
    try {
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      const base = `http://127.0.0.1:${address.port}`;

      const summaryResponse = await fetch(base + '/api/summary');
      const summary = await summaryResponse.json();
      expect(summaryResponse.status).toBe(200);
      expect(summaryResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(summaryResponse.headers.get('x-content-type-options')).toBe('nosniff');
      expect(summaryResponse.headers.get('referrer-policy')).toBe('no-referrer');
      expect(summary).toMatchObject({
        totalRuns: 4,
        cards: {
          estimatedTokensSaved: 90,
          averageReduction: 0.3,
          criticalRetention: 0.75,
          taskPassRate: 0.5,
          requests: 1,
          apiUsage: { inputTokens: 100, outputTokens: 20 },
          knownCostUsd: 0.01,
        },
        comparison: {
          jev: { runs: 2, averageReduction: 0.4 },
          local: { runs: 2, averageReduction: 0.25 },
        },
      });
      expect(summary.trends.map((trend: { id: string }) => trend.id)).toEqual([
        'run-aaaa1111',
        'run-bbbb2222',
        'run-cccc3333',
      ]);

      const runsResponse = await fetch(
        base + '/api/runs?mode=local&status=applied&from=2026-01-03&to=2026-01-03&limit=1',
      );
      const runsText = await runsResponse.text();
      expect(runsResponse.status).toBe(200);
      expect(runsText).not.toMatch(/secret prompt|secret output|decisions/);
      expect(JSON.parse(runsText)).toMatchObject({
        returned: 1,
        available: 1,
        runs: [{ id: 'run-cccc3333', decisionCounts: { kept: 0, truncated: 0, removed: 0 } }],
      });

      const detailResponse = await fetch(base + '/api/runs/run-aaaa1111');
      const detailText = await detailResponse.text();
      expect(detailResponse.status).toBe(200);
      expect(detailText).not.toMatch(/secret prompt|secret output/);
      expect(JSON.parse(detailText).run.decisions).toHaveLength(1);

      expect((await fetch(base + '/api/runs?mode=invalid')).status).toBe(400);
      expect((await fetch(base + '/api/runs?from=today')).status).toBe(400);
      expect((await fetch(base + '/api/runs?from=2026-02-30T00:00:00Z')).status).toBe(400);
      expect((await fetch(base + '/api/runs/run-zzzz9999')).status).toBe(404);
      const methodResponse = await fetch(base + '/api/runs', { method: 'POST' });
      expect(methodResponse.status).toBe(405);
      expect(methodResponse.headers.get('allow')).toBe('GET');

      await writeFile(historyPath, '{malformed}\n{"version":1}\n', 'utf8');
      expect(await (await fetch(base + '/api/summary')).json()).toMatchObject({
        totalRuns: 0,
        cards: {
          estimatedTokensSaved: 0,
          averageReduction: null,
          criticalRetention: null,
          taskPassRate: null,
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});
