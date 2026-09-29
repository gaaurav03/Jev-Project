import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { MAX_TELEMETRY_BYTES, parseTelemetryEvent } from './telemetry.js';

export interface CommunityEnvironment {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  JEV_CLOUD_INGEST_TOKEN?: string;
}

export interface TelemetryRequest {
  method?: string;
  contentType?: string;
  forwardedFor?: string;
  body: string;
}

export interface TelemetryResponse {
  status: number;
  body: { ok: boolean; error?: string };
}

export interface CommunityStats {
  scope: 'community';
  generatedAt: string;
  installs: number;
  activeInstalls7d: number;
  activeInstalls30d: number;
  runs: number;
  compactions: number;
  tokensBefore: number;
  tokensSaved: number;
  averageReduction: number | null;
  modes: { jev: number; local: number };
  daily: Array<{ date: string; compactions: number; tokensSaved: number; activeInstalls: number }>;
}

type RpcFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; text: () => Promise<string> }>;

function supabase(environment: CommunityEnvironment): { base: URL; key: string } | null {
  const key = environment.SUPABASE_SERVICE_ROLE_KEY;
  let base: URL;
  try { base = new URL(environment.SUPABASE_URL ?? ''); } catch { return null; }
  if (!key || base.protocol !== 'https:' || base.username || base.password) return null;
  return { base, key };
}

async function rpc(
  environment: CommunityEnvironment,
  fetchFn: RpcFetch,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const target = supabase(environment);
  if (!target) throw new Error('unconfigured');
  const response = await fetchFn(new URL(`/rest/v1/rpc/${name}`, target.base).href, {
    method: 'POST',
    headers: {
      apikey: target.key,
      authorization: `Bearer ${target.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error('upstream failed');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('response too large');
  return JSON.parse(text);
}

/**
 * A per-day keyed hash of the caller's address, used only to rate-limit one
 * network source. The raw address is never stored and the hash rotates daily.
 */
export function sourceHash(forwardedFor: string | undefined, secret: string, now = new Date()): string {
  const address = forwardedFor?.split(',')[0]?.trim().slice(0, 64) || 'unknown';
  return createHmac('sha256', secret)
    .update(`telemetry-source:${now.toISOString().slice(0, 10)}:${address}`)
    .digest('hex');
}

/** Validates one anonymous event and records it unless its source is rate limited. */
export async function ingestTelemetry(
  request: TelemetryRequest,
  environment: CommunityEnvironment,
  fetchFn: RpcFetch,
): Promise<TelemetryResponse> {
  if (request.method !== 'POST') return { status: 405, body: { ok: false, error: 'Method not allowed' } };
  if (typeof request.contentType !== 'string' ||
      !request.contentType.toLowerCase().startsWith('application/json')) {
    return { status: 415, body: { ok: false, error: 'JSON required' } };
  }
  if (Buffer.byteLength(request.body, 'utf8') > MAX_TELEMETRY_BYTES) {
    return { status: 413, body: { ok: false, error: 'Payload too large' } };
  }
  let event;
  try { event = parseTelemetryEvent(JSON.parse(request.body)); } catch { event = null; }
  if (!event) return { status: 400, body: { ok: false, error: 'Invalid event' } };

  const secret = environment.JEV_CLOUD_INGEST_TOKEN;
  if (!secret || secret.length < 32 || !supabase(environment)) {
    return { status: 503, body: { ok: false, error: 'Service unavailable' } };
  }
  try {
    const outcome = await rpc(environment, fetchFn, 'record_telemetry', {
      p_install_id: event.install_id,
      p_source_hash: sourceHash(request.forwardedFor, secret),
      p_plugin_version: event.plugin_version,
      p_mode: event.mode,
      p_status: event.status,
      p_tokens_before: event.tokens_before,
      p_tokens_after: event.tokens_after,
      p_latency_ms: event.latency_ms,
    });
    if (outcome === 'rate_limited') return { status: 429, body: { ok: false, error: 'Too many events' } };
    if (outcome !== 'accepted') throw new Error('unexpected outcome');
    return { status: 202, body: { ok: true } };
  } catch {
    return { status: 502, body: { ok: false, error: 'Telemetry unavailable' } };
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Validates the database aggregate before it reaches the public page. */
export function parseCommunityStats(value: unknown, now = new Date()): CommunityStats | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const modes = raw.modes as Record<string, unknown> | null;
  const numbers = [
    raw.installs, raw.activeInstalls7d, raw.activeInstalls30d, raw.runs,
    raw.compactions, raw.tokensBefore, raw.tokensSaved,
  ].map(count);
  const average = raw.averageReduction;
  if (
    numbers.some((entry) => entry === null) ||
    !(average === null || (typeof average === 'number' && average >= 0 && average <= 1)) ||
    !modes || typeof modes !== 'object' || count(modes.jev) === null || count(modes.local) === null ||
    !Array.isArray(raw.daily) || raw.daily.length > 31
  ) return null;
  const daily = raw.daily.map((entry: unknown) => {
    const day = entry as Record<string, unknown> | null;
    if (!day || typeof day !== 'object' || typeof day.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return null;
    const values = [day.compactions, day.tokensSaved, day.activeInstalls].map(count);
    if (values.some((entry) => entry === null)) return null;
    return {
      date: day.date,
      compactions: values[0]!,
      tokensSaved: values[1]!,
      activeInstalls: values[2]!,
    };
  });
  if (daily.some((entry) => entry === null)) return null;
  const [installs, active7, active30, runs, compactions, before, saved] = numbers as number[];
  return {
    scope: 'community',
    generatedAt: now.toISOString(),
    installs: installs!,
    activeInstalls7d: active7!,
    activeInstalls30d: active30!,
    runs: runs!,
    compactions: compactions!,
    tokensBefore: before!,
    tokensSaved: saved!,
    averageReduction: average as number | null,
    modes: { jev: modes.jev as number, local: modes.local as number },
    daily: daily as CommunityStats['daily'],
  };
}

export async function readCommunityStats(
  environment: CommunityEnvironment,
  fetchFn: RpcFetch,
): Promise<CommunityStats> {
  try {
    const stats = parseCommunityStats(await rpc(environment, fetchFn, 'community_stats', {}));
    if (!stats) throw new Error('invalid stats');
    return stats;
  } catch {
    throw new Error('Community metrics unavailable');
  }
}
