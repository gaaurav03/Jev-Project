import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { recordLiveRun, resolveHookConfig, sendTelemetry } from '../hooks/fast-jev.ts';
import {
  ingestTelemetry,
  parseCommunityStats,
  readCommunityStats,
  sourceHash,
} from '../src/community.js';
import { createRunRecord, type RunRecord } from '../src/run-record.js';
import {
  DEFAULT_TELEMETRY_URL,
  PLUGIN_VERSION,
  TELEMETRY_NOTICE,
  newInstallId,
  parseTelemetryEvent,
  telemetryEnabled,
  toTelemetryEvent,
} from '../src/telemetry.js';

const INSTALL = 'a'.repeat(32);
const SECRET = 's'.repeat(64);

function liveRecord(overrides: Partial<Parameters<typeof createRunRecord>[0]> = {}): RunRecord {
  return createRunRecord({
    source: 'live',
    mode: 'local',
    status: 'applied',
    fallbackReason: null,
    metrics: {
      estimatedTokensBefore: 1000,
      estimatedTokensAfter: 600,
      estimatedTokensSaved: 400,
      estimatedReduction: 0.4,
      latencyMs: 12.6,
      requests: 0,
      apiUsage: null,
      costUsd: null,
      criticalRetention: null,
      taskPassed: null,
    },
    decisions: [{
      id: 't1', tool: 'Read', action: 'drop_call', reason: 'call_dropped', keepCall: 0.1, keepResult: 0.1,
    }],
    benchmark: null,
    ...overrides,
  });
}

function host(env: Record<string, string> = {}, store: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const requests: Array<{ url: string; body: string }> = [];
  return {
    logs,
    requests,
    store,
    $: {
      fs: { exists: async () => false, read: async () => '', write: async () => undefined },
      session: { cwd: async () => 'C:/w', repo: async () => null },
      ui: { log: (text: string) => { logs.push(text); } },
      env: { get: async (name: string) => env[name] },
      http: {
        fetch: async (url: string, init?: { body?: string }) => {
          requests.push({ url, body: init?.body ?? '' });
          return { status: 202, ok: true, text: '{"ok":true}' };
        },
      },
      clock: { after: () => ({ cancel: () => undefined }) },
      store: {
        get: async (key: string) => store[key],
        set: async (key: string, value: unknown) => { store[key] = value; },
      },
    },
  };
}

describe('telemetry client', () => {
  it('is on by default and honours every opt-out', () => {
    expect(telemetryEnabled({})).toBe(true);
    expect(telemetryEnabled({ option: false })).toBe(false);
    for (const value of ['0', 'false', 'OFF', ' no ']) {
      expect(telemetryEnabled({ jevTelemetry: value })).toBe(false);
    }
    expect(telemetryEnabled({ doNotTrack: '1' })).toBe(false);
    expect(resolveHookConfig({}).telemetry).toBe(true);
    expect(resolveHookConfig({ telemetry: false }).telemetry).toBe(false);
  });

  it('reduces a live run to anonymous counts only', () => {
    const event = toTelemetryEvent(liveRecord(), INSTALL);
    expect(event).toEqual({
      v: 1,
      install_id: INSTALL,
      plugin_version: PLUGIN_VERSION,
      mode: 'local',
      status: 'applied',
      tokens_before: 1000,
      tokens_after: 600,
      latency_ms: 13,
    });
    expect(JSON.stringify(event)).not.toMatch(/Read|t1|run-|drop_call/);
    const live = liveRecord();
    expect(toTelemetryEvent(liveRecord({
      source: 'benchmark',
      status: 'passed',
      metrics: {
        ...live.metrics!,
        criticalRetention: { required: 1, retained: 1, ratio: 1 },
        taskPassed: true,
      },
      benchmark: { caseId: 'obsolete-read', category: 'obsolete-read' },
    }), INSTALL)).toBeNull();
    expect(parseTelemetryEvent({ ...event, extra: 1 })).toBeNull();
    expect(parseTelemetryEvent({ ...event, tokens_after: 2000 })).toBeNull();
    expect(parseTelemetryEvent({ ...event, install_id: 'ALICE' })).toBeNull();
    expect(parseTelemetryEvent({ ...event, tokens_before: 10_000_000_000 })).toBeNull();
    expect(newInstallId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps the plugin version in sync with the manifest', async () => {
    const manifest = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8')) as {
      version: string;
      userConfig: Record<string, { type: string; default?: unknown }>;
    };
    expect(PLUGIN_VERSION).toBe(manifest.version);
    expect(manifest.userConfig.telemetry).toMatchObject({ type: 'boolean', default: true });
  });

  it('shows the notice and sends nothing on first use, then sends one event', async () => {
    const context = host();
    const config = resolveHookConfig({ mode: 'local' });
    await sendTelemetry(context.$, config, liveRecord());
    expect(context.requests).toEqual([]);
    expect(context.logs).toEqual([TELEMETRY_NOTICE]);
    expect(context.store.installId).toMatch(/^[0-9a-f]{32}$/);

    await sendTelemetry(context.$, config, liveRecord());
    expect(context.requests).toHaveLength(1);
    expect(context.requests[0]!.url).toBe(DEFAULT_TELEMETRY_URL);
    expect(JSON.parse(context.requests[0]!.body)).toMatchObject({
      install_id: context.store.installId,
      status: 'applied',
      tokens_before: 1000,
    });
    expect(context.logs).toHaveLength(1);
  });

  it('does nothing at all after opting out', async () => {
    for (const [env, options] of [
      [{ JEV_TELEMETRY: '0' }, {}],
      [{ DO_NOT_TRACK: '1' }, {}],
      [{}, { telemetry: false }],
    ] as const) {
      const context = host(env, { installId: INSTALL });
      await sendTelemetry(context.$, resolveHookConfig(options), liveRecord());
      expect(context.requests).toEqual([]);
      const fresh = host(env);
      await sendTelemetry(fresh.$, resolveHookConfig(options), liveRecord());
      expect(fresh.store).toEqual({});
      expect(fresh.logs).toEqual([]);
    }
  });

  it('never surfaces telemetry failures from recordLiveRun', async () => {
    const context = host({}, { installId: INSTALL });
    context.$.http.fetch = async () => { throw new Error('offline'); };
    await expect(recordLiveRun(
      context.$,
      resolveHookConfig({ mode: 'local' }),
      'fallback',
      'compaction_error',
    )).resolves.toBeUndefined();
    expect(context.logs).toEqual([]);
  });
});

describe('telemetry endpoint', () => {
  const environment = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    JEV_CLOUD_INGEST_TOKEN: SECRET,
  };
  const body = JSON.stringify(toTelemetryEvent(liveRecord(), INSTALL));

  function rpcFetch(result: unknown, ok = true) {
    return vi.fn(async (_url: string, _init: { body: string }) => ({
      ok,
      text: async () => JSON.stringify(result),
    }));
  }

  it('records a valid event with a hashed, rotating source instead of the address', async () => {
    const fetcher = rpcFetch('accepted');
    const response = await ingestTelemetry(
      { method: 'POST', contentType: 'application/json', forwardedFor: '203.0.113.9, 10.0.0.1', body },
      environment,
      fetcher,
    );
    expect(response).toEqual({ status: 202, body: { ok: true } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://project.supabase.co/rest/v1/rpc/record_telemetry');
    expect(init.body).not.toContain('203.0.113.9');
    expect(JSON.parse(init.body)).toMatchObject({
      p_install_id: INSTALL,
      p_source_hash: sourceHash('203.0.113.9', SECRET),
      p_tokens_before: 1000,
      p_tokens_after: 600,
    });
    expect(sourceHash('203.0.113.9', SECRET, new Date('2026-01-01')))
      .not.toBe(sourceHash('203.0.113.9', SECRET, new Date('2026-01-02')));
  });

  it('rejects invalid input and hides upstream failures', async () => {
    const request = { method: 'POST', contentType: 'application/json', body };
    expect((await ingestTelemetry({ ...request, method: 'GET' }, environment, rpcFetch('accepted'))).status).toBe(405);
    expect((await ingestTelemetry({ ...request, contentType: 'text/plain' }, environment, rpcFetch('accepted'))).status).toBe(415);
    expect((await ingestTelemetry({ ...request, body: '{"v":1}' }, environment, rpcFetch('accepted'))).status).toBe(400);
    expect((await ingestTelemetry({ ...request, body: 'x'.repeat(2000) }, environment, rpcFetch('accepted'))).status).toBe(413);
    expect(await ingestTelemetry(request, environment, rpcFetch('rate_limited')))
      .toEqual({ status: 429, body: { ok: false, error: 'Too many events' } });
    expect(await ingestTelemetry(request, environment, rpcFetch({ message: 'secret detail' }, false)))
      .toEqual({ status: 502, body: { ok: false, error: 'Telemetry unavailable' } });
    expect((await ingestTelemetry(request, { ...environment, JEV_CLOUD_INGEST_TOKEN: '' }, rpcFetch('accepted'))).status)
      .toBe(503);
  });

  it('serves validated community totals and hides database errors', async () => {
    const totals = {
      installs: 3, activeInstalls7d: 2, activeInstalls30d: 3, runs: 10, compactions: 8,
      tokensBefore: 10_000, tokensSaved: 4_000, averageReduction: 0.4,
      modes: { jev: 5, local: 3 },
      daily: [{ date: '2026-09-30', compactions: 8, tokensSaved: 4_000, activeInstalls: 3 }],
    };
    const stats = await readCommunityStats(environment, rpcFetch(totals));
    expect(stats).toMatchObject({ scope: 'community', ...totals });
    expect(parseCommunityStats({ ...totals, installs: -1 })).toBeNull();
    expect(parseCommunityStats({ ...totals, averageReduction: 2 })).toBeNull();
    await expect(readCommunityStats(environment, rpcFetch({ hint: 'db' }, false)))
      .rejects.toThrow('Community metrics unavailable');
  });

  it('keeps the telemetry table and functions away from browser roles', async () => {
    const sql = await readFile('supabase/migrations/20260930120000_create_telemetry_events.sql', 'utf8');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('revoke all on table public.telemetry_events from anon, authenticated');
    expect(sql).toMatch(/revoke all on function public\.record_telemetry\([^)]*\)\s+from public, anon, authenticated/);
    expect(sql).toContain('revoke all on function public.community_stats() from public, anon, authenticated');
    expect(sql).not.toMatch(/security definer|create\s+policy/i);
    expect(sql).not.toMatch(/^\s*(ip|ip_address|prompt|transcript|tool_name|path)\s+/im);
  });
});
