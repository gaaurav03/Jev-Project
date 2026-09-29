import { parseRunRecord, type RunRecord } from './run-record.js';

export const CLOUD_UPLOAD_TIMEOUT_MS = 3_000;
export const MAX_CLOUD_RUN_BYTES = 32 * 1024;

export interface CloudUploadConfig {
  url: string;
  token: string;
}

export interface CloudRun {
  id: string;
  record_version: 1;
  run_at: string;
  source: RunRecord['source'];
  mode: RunRecord['mode'];
  status: RunRecord['status'];
  fallback_reason: RunRecord['fallbackReason'];
  estimated_tokens_before: number | null;
  estimated_tokens_after: number | null;
  estimated_tokens_saved: number | null;
  estimated_reduction: number | null;
  latency_ms: number | null;
  request_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  known_cost_usd: number | null;
  critical_required: number | null;
  critical_retained: number | null;
  task_passed: boolean | null;
  kept_count: number;
  truncated_count: number;
  removed_count: number;
}

export type CloudFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean }>;

const FIELDS: readonly (keyof CloudRun)[] = [
  'id', 'record_version', 'run_at', 'source', 'mode', 'status', 'fallback_reason',
  'estimated_tokens_before', 'estimated_tokens_after', 'estimated_tokens_saved',
  'estimated_reduction', 'latency_ms', 'request_count', 'input_tokens', 'output_tokens',
  'known_cost_usd', 'critical_required', 'critical_retained', 'task_passed',
  'kept_count', 'truncated_count', 'removed_count',
];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function integer(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function nullableNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null | undefined {
  return value === null ? null : number(value, maximum) ?? undefined;
}

function nullableInteger(value: unknown): number | null | undefined {
  return value === null ? null : integer(value) ?? undefined;
}

/** Validates the exact public-safe row accepted by the ingestion endpoint. */
export function parseCloudRun(value: unknown): CloudRun | null {
  const raw = object(value);
  if (!raw || Object.keys(raw).length !== FIELDS.length ||
      Object.keys(raw).some((key) => !FIELDS.includes(key as keyof CloudRun))) return null;

  const before = nullableInteger(raw.estimated_tokens_before);
  const after = nullableInteger(raw.estimated_tokens_after);
  const saved = nullableInteger(raw.estimated_tokens_saved);
  const reduction = nullableNumber(raw.estimated_reduction, 1);
  const latency = nullableNumber(raw.latency_ms);
  const requests = nullableInteger(raw.request_count);
  const input = nullableInteger(raw.input_tokens);
  const output = nullableInteger(raw.output_tokens);
  const cost = nullableNumber(raw.known_cost_usd);
  const required = nullableInteger(raw.critical_required);
  const retained = nullableInteger(raw.critical_retained);
  const kept = integer(raw.kept_count);
  const truncated = integer(raw.truncated_count);
  const removed = integer(raw.removed_count);
  const source = raw.source === 'live' || raw.source === 'benchmark' ? raw.source : null;
  const mode = raw.mode === 'jev' || raw.mode === 'local' ? raw.mode : null;
  const status = ['applied', 'fallback', 'passed', 'failed'].includes(String(raw.status))
    ? raw.status as CloudRun['status']
    : null;
  const fallback = raw.fallback_reason === null || [
    'below_minimum_reduction', 'missing_api_key', 'request_timeout',
    'remote_error', 'compaction_error',
  ].includes(String(raw.fallback_reason)) ? raw.fallback_reason as CloudRun['fallback_reason'] : undefined;
  const core = [before, after, saved, reduction, latency, requests];
  const noMetrics = core.every((entry) => entry === null);
  const fullMetrics = core.every((entry) => typeof entry === 'number');

  if (
    raw.record_version !== 1 ||
    typeof raw.id !== 'string' || !/^run-[a-z0-9-]{8,80}$/.test(raw.id) ||
    typeof raw.run_at !== 'string' || Number.isNaN(Date.parse(raw.run_at)) ||
    !source || !mode || !status || fallback === undefined ||
    [before, after, saved, reduction, latency, requests, input, output, cost,
      required, retained].some((entry) => entry === undefined) ||
    kept === null || truncated === null || removed === null ||
    (!noMetrics && !fullMetrics) ||
    (fullMetrics && (after! > before! || saved !== before! - after!)) ||
    (noMetrics && (input !== null || output !== null || cost !== null)) ||
    (source === 'live' && (!['applied', 'fallback'].includes(status) ||
      required !== null || retained !== null || raw.task_passed !== null)) ||
    (source === 'benchmark' && (!['passed', 'failed'].includes(status) ||
      required === null || retained === null || (retained as number) > (required as number) ||
      typeof raw.task_passed !== 'boolean' || ((status === 'passed') !== raw.task_passed))) ||
    ((status === 'fallback') !== (fallback !== null)) ||
    (status !== 'fallback' && noMetrics)
  ) return null;

  return {
    id: raw.id,
    record_version: 1,
    run_at: new Date(raw.run_at).toISOString(),
    source,
    mode,
    status,
    fallback_reason: fallback,
    estimated_tokens_before: before!,
    estimated_tokens_after: after!,
    estimated_tokens_saved: saved!,
    estimated_reduction: reduction!,
    latency_ms: latency!,
    request_count: requests!,
    input_tokens: input!,
    output_tokens: output!,
    known_cost_usd: cost!,
    critical_required: required!,
    critical_retained: retained!,
    task_passed: raw.task_passed as boolean | null,
    kept_count: kept,
    truncated_count: truncated,
    removed_count: removed,
  };
}

/** Removes local-only detail before any cloud serialization occurs. */
export function toCloudRun(value: unknown): CloudRun {
  const record = parseRunRecord(value);
  if (!record) throw new Error('Invalid run record');
  const metrics = record.metrics;
  const row = parseCloudRun({
    id: record.id,
    record_version: 1,
    run_at: record.timestamp,
    source: record.source,
    mode: record.mode,
    status: record.status,
    fallback_reason: record.fallbackReason,
    estimated_tokens_before: metrics?.estimatedTokensBefore ?? null,
    estimated_tokens_after: metrics?.estimatedTokensAfter ?? null,
    estimated_tokens_saved: metrics?.estimatedTokensSaved ?? null,
    estimated_reduction: metrics?.estimatedReduction ?? null,
    latency_ms: metrics?.latencyMs ?? null,
    request_count: metrics?.requests ?? null,
    input_tokens: metrics?.apiUsage?.inputTokens ?? null,
    output_tokens: metrics?.apiUsage?.outputTokens ?? null,
    known_cost_usd: metrics?.costUsd ?? null,
    critical_required: metrics?.criticalRetention?.required ?? null,
    critical_retained: metrics?.criticalRetention?.retained ?? null,
    task_passed: metrics?.taskPassed ?? null,
    kept_count: record.decisions.filter((decision) => decision.action === 'keep').length,
    truncated_count: record.decisions.filter((decision) => decision.action === 'drop_result').length,
    removed_count: record.decisions.filter((decision) => decision.action === 'drop_call').length,
  });
  if (!row) throw new Error('Run record cannot be uploaded');
  return row;
}

export function cloudUploadConfig(
  enabled: string | undefined,
  url: string | undefined,
  token: string | undefined,
): CloudUploadConfig | null {
  if (enabled !== '1') return null;
  if (!url || !token || !/^[!-~]{32,512}$/.test(token)) {
    throw new Error('Cloud upload configuration is incomplete');
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Cloud ingestion URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || url.length > 2048) {
    throw new Error('Cloud ingestion URL must be HTTPS');
  }
  return { url: parsed.href, token };
}

export async function uploadCloudRun(
  record: RunRecord,
  config: CloudUploadConfig,
  fetchFn: CloudFetch,
): Promise<void> {
  const body = JSON.stringify(toCloudRun(record));
  if (body.length > MAX_CLOUD_RUN_BYTES) throw new Error('Cloud run exceeds size limit');
  const response = await fetchFn(config.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body,
  });
  if (!response.ok) throw new Error('Cloud upload failed');
}