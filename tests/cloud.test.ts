import { describe, expect, it, vi } from 'vitest';

import {
  cloudUploadConfig,
  parseCloudRun,
  toCloudRun,
  uploadCloudRun,
} from '../src/cloud.js';
import { ingestCloudRun } from '../src/cloud-ingest.js';
import { createRunRecord } from '../src/run-record.js';

const token = 'a'.repeat(64);

function run() {
  return createRunRecord({
    source: 'benchmark',
    mode: 'jev',
    status: 'passed',
    fallbackReason: null,
    metrics: {
      estimatedTokensBefore: 100,
      estimatedTokensAfter: 60,
      estimatedTokensSaved: 40,
      estimatedReduction: 0.4,
      latencyMs: 12,
      requests: 1,
      apiUsage: { inputTokens: 30, outputTokens: 5 },
      costUsd: null,
      criticalRetention: { required: 1, retained: 1, ratio: 1 },
      taskPassed: true,
    },
    decisions: [{
      id: 't1',
      tool: 'alice@example.com',
      action: 'drop_result',
      reason: 'result_dropped',
      keepCall: 0.8,
      keepResult: 0.2,
    }],
    benchmark: { caseId: 'private-case', category: 'private-category' },
  });
}

describe('cloud runs', () => {
  it('serializes only aggregate public-safe fields', async () => {
    const record = run();
    const row = toCloudRun(record);
    const serialized = JSON.stringify(row);
    expect(row).toMatchObject({
      id: record.id,
      source: 'benchmark',
      truncated_count: 1,
      removed_count: 0,
      kept_count: 0,
      critical_required: 1,
      task_passed: true,
    });
    expect(serialized).not.toMatch(/alice@example\.com|private-case|private-category/);
    expect(row).not.toHaveProperty('decisions');
    expect(row).not.toHaveProperty('benchmark');

    const fetcher = vi.fn(async () => ({ ok: true }));
    await uploadCloudRun(
      record,
      cloudUploadConfig('1', 'https://example.test/api/ingest', token)!,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(serialized);
  });

  it('requires explicit HTTPS configuration and exact valid rows', () => {
    expect(cloudUploadConfig(undefined, undefined, undefined)).toBeNull();
    expect(() => cloudUploadConfig('1', 'http://example.test', token)).toThrow(/HTTPS/);
    expect(parseCloudRun({ ...toCloudRun(run()), secret: 'must-not-pass' })).toBeNull();
    expect(parseCloudRun({ ...toCloudRun(run()), estimated_tokens_saved: 39 })).toBeNull();
  });
});

describe('cloud ingestion', () => {
  it('authenticates and forwards a bounded row with the server-only key', async () => {
    const row = toCloudRun(run());
    const fetcher = vi.fn(async () => ({ ok: true }));
    const response = await ingestCloudRun(
      {
        method: 'POST',
        authorization: `Bearer ${token}`,
        contentType: 'application/json',
        body: JSON.stringify(row),
      },
      {
        JEV_CLOUD_INGEST_TOKEN: token,
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
      },
      fetcher,
    );
    expect(response).toEqual({ status: 202, body: { ok: true } });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://project.supabase.co/rest/v1/compaction_runs?on_conflict=id',
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      apikey: 'server-only-key',
      authorization: 'Bearer server-only-key',
    });
  });

  it('rejects bad authorization and hides upstream errors', async () => {
    const body = JSON.stringify(toCloudRun(run()));
    const environment = {
      JEV_CLOUD_INGEST_TOKEN: token,
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    };
    const unauthorized = await ingestCloudRun(
      { method: 'POST', authorization: 'Bearer wrong', contentType: 'application/json', body },
      environment,
      async () => { throw new Error('must not run'); },
    );
    expect(unauthorized.status).toBe(401);

    const failed = await ingestCloudRun(
      { method: 'POST', authorization: `Bearer ${token}`, contentType: 'application/json', body },
      environment,
      async () => { throw new Error('database password leaked'); },
    );
    expect(JSON.stringify(failed)).toBe('{"status":502,"body":{"ok":false,"error":"Upload unavailable"}}');
  });
});