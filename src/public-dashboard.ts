import { Buffer } from 'node:buffer';

import { parseCloudRun, type CloudRun } from './cloud.js';
import {
  parseDashboardFilters,
  summarizeRuns,
  type DashboardSummary,
  type DashboardSummaryRun,
} from './dashboard.js';
import type { RunMetrics } from './run-record.js';

export const MAX_CLOUD_HISTORY_ROWS = 1_000;
export const MAX_CLOUD_RESPONSE_BYTES = 1024 * 1024;

export interface PublicDashboardEnvironment {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

type PublicFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; text: () => Promise<string> }>;

export type PublicDashboardSummary = Omit<DashboardSummary, 'trends'> & {
  scope: 'public';
  trends: Array<Omit<DashboardSummary['trends'][number], 'id'>>;
};

export interface PublicDashboardRun {
  timestamp: string;
  source: CloudRun['source'];
  mode: CloudRun['mode'];
  status: CloudRun['status'];
  metrics: RunMetrics | null;
  decisionCounts: { kept: number; truncated: number; removed: number };
}

const CLOUD_FIELDS = [
  'id', 'record_version', 'run_at', 'source', 'mode', 'status', 'fallback_reason',
  'estimated_tokens_before', 'estimated_tokens_after', 'estimated_tokens_saved',
  'estimated_reduction', 'latency_ms', 'request_count', 'input_tokens', 'output_tokens',
  'known_cost_usd', 'critical_required', 'critical_retained', 'task_passed',
  'kept_count', 'truncated_count', 'removed_count',
].join(',');

function cloudMetrics(row: CloudRun): RunMetrics | null {
  if (row.estimated_tokens_before === null) return null;
  const criticalRetention = row.critical_required === null
    ? null
    : {
        required: row.critical_required,
        retained: row.critical_retained!,
        ratio: row.critical_required === 0 ? 1 : row.critical_retained! / row.critical_required,
      };
  const apiUsage = row.input_tokens === null && row.output_tokens === null
    ? null
    : { inputTokens: row.input_tokens, outputTokens: row.output_tokens };
  return {
    estimatedTokensBefore: row.estimated_tokens_before,
    estimatedTokensAfter: row.estimated_tokens_after!,
    estimatedTokensSaved: row.estimated_tokens_saved!,
    estimatedReduction: row.estimated_reduction!,
    latencyMs: row.latency_ms!,
    requests: row.request_count!,
    apiUsage,
    costUsd: row.known_cost_usd,
    criticalRetention,
    taskPassed: row.task_passed,
  };
}

function cloudRecord(row: CloudRun): DashboardSummaryRun {
  return {
    id: row.id,
    timestamp: row.run_at,
    source: row.source,
    mode: row.mode,
    metrics: cloudMetrics(row),
  };
}

export async function readCloudRuns(
  environment: PublicDashboardEnvironment,
  fetchFn: PublicFetch,
): Promise<CloudRun[]> {
  const key = environment.SUPABASE_SERVICE_ROLE_KEY;
  let base: URL;
  try { base = new URL(environment.SUPABASE_URL ?? ''); } catch {
    throw new Error('Cloud metrics unavailable');
  }
  if (!key || base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('Cloud metrics unavailable');
  }
  const endpoint = new URL('/rest/v1/compaction_runs', base);
  endpoint.searchParams.set('select', CLOUD_FIELDS);
  endpoint.searchParams.set('order', 'run_at.desc');
  endpoint.searchParams.set('limit', String(MAX_CLOUD_HISTORY_ROWS));
  try {
    const response = await fetchFn(endpoint.href, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error('upstream failed');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_CLOUD_RESPONSE_BYTES) {
      throw new Error('response too large');
    }
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length > MAX_CLOUD_HISTORY_ROWS) {
      throw new Error('invalid response');
    }
    const rows = value.map(parseCloudRun);
    if (rows.some((row) => row === null)) throw new Error('invalid row');
    return rows as CloudRun[];
  } catch {
    throw new Error('Cloud metrics unavailable');
  }
}

export function summarizeCloudRuns(rows: readonly CloudRun[]): PublicDashboardSummary {
  const summary = summarizeRuns(rows.map(cloudRecord));
  return {
    ...summary,
    scope: 'public',
    trends: summary.trends.map(({ id: _id, ...trend }) => trend),
  };
}

export function listCloudRuns(rows: readonly CloudRun[], url: URL): {
  runs: PublicDashboardRun[];
  returned: number;
  available: number;
  limit: number;
} {
  const filters = parseDashboardFilters(url);
  const matching = rows.filter((row) => {
    const time = Date.parse(row.run_at);
    return (
      (filters.mode === undefined || row.mode === filters.mode) &&
      (filters.status === undefined || row.status === filters.status) &&
      (filters.from === undefined || time >= filters.from) &&
      (filters.to === undefined || time <= filters.to)
    );
  });
  const selected = matching.slice(0, filters.limit);
  return {
    runs: selected.map((row) => ({
      timestamp: row.run_at,
      source: row.source,
      mode: row.mode,
      status: row.status,
      metrics: cloudMetrics(row),
      decisionCounts: {
        kept: row.kept_count,
        truncated: row.truncated_count,
        removed: row.removed_count,
      },
    })),
    returned: selected.length,
    available: matching.length,
    limit: filters.limit,
  };
}