import { createHash, timingSafeEqual } from 'node:crypto';

import { MAX_CLOUD_RUN_BYTES, parseCloudRun } from './cloud.js';

export interface IngestEnvironment {
  JEV_CLOUD_INGEST_TOKEN?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export interface IngestRequest {
  method?: string;
  authorization?: string;
  contentType?: string;
  body: string;
}

export interface IngestResponse {
  status: number;
  body: { ok: boolean; error?: string };
}

type ServerFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean }>;

function sameSecret(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/** Authenticates, validates, and forwards one already-sanitized run to Supabase. */
export async function ingestCloudRun(
  request: IngestRequest,
  environment: IngestEnvironment,
  fetchFn: ServerFetch,
): Promise<IngestResponse> {
  if (request.method !== 'POST') return { status: 405, body: { ok: false, error: 'Method not allowed' } };
  const expected = environment.JEV_CLOUD_INGEST_TOKEN;
  const supplied = request.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!expected || expected.length < 32 || !supplied || !sameSecret(supplied, expected)) {
    return { status: 401, body: { ok: false, error: 'Unauthorized' } };
  }
  if (typeof request.contentType !== 'string' ||
      !request.contentType.toLowerCase().startsWith('application/json')) {
    return { status: 415, body: { ok: false, error: 'JSON required' } };
  }
  if (Buffer.byteLength(request.body, 'utf8') > MAX_CLOUD_RUN_BYTES) {
    return { status: 413, body: { ok: false, error: 'Payload too large' } };
  }
  let row;
  try { row = parseCloudRun(JSON.parse(request.body)); } catch { row = null; }
  if (!row) return { status: 400, body: { ok: false, error: 'Invalid run' } };

  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  let base: URL;
  try { base = new URL(environment.SUPABASE_URL ?? ''); } catch {
    return { status: 503, body: { ok: false, error: 'Service unavailable' } };
  }
  if (!serviceKey || base.protocol !== 'https:' || base.username || base.password) {
    return { status: 503, body: { ok: false, error: 'Service unavailable' } };
  }
  const endpoint = new URL('/rest/v1/compaction_runs?on_conflict=id', base);
  try {
    const response = await fetchFn(endpoint.href, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
        prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error('upstream failed');
    return { status: 202, body: { ok: true } };
  } catch {
    return { status: 502, body: { ok: false, error: 'Upload unavailable' } };
  }
}