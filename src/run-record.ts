import type {
  CallAction,
  CallDecision,
  CompactResult,
  CompactionMode,
} from './types.js';

export const RUN_RECORD_VERSION = 1 as const;
export const DEFAULT_RUN_HISTORY_PATH = '.jev/runs.jsonl';
export const MAX_RUN_HISTORY_RECORDS = 1_000;

export type RunSource = 'live' | 'benchmark';
export type RunStatus = 'applied' | 'fallback' | 'passed' | 'failed';
export type RunFallbackReason =
  | 'below_minimum_reduction'
  | 'missing_api_key'
  | 'request_timeout'
  | 'remote_error'
  | 'compaction_error';

export interface RunDecision {
  id: string;
  tool: string;
  action: CallAction;
  reason: CallDecision['reason'];
  keepCall: number;
  keepResult: number;
}

export interface RunMetrics {
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  estimatedReduction: number;
  latencyMs: number;
  requests: number;
  apiUsage: CompactResult['stats']['apiUsage'];
  costUsd: number | null;
  criticalRetention: {
    required: number;
    retained: number;
    ratio: number;
  } | null;
  taskPassed: boolean | null;
}

export interface RunRecord {
  version: typeof RUN_RECORD_VERSION;
  id: string;
  timestamp: string;
  source: RunSource;
  mode: CompactionMode;
  status: RunStatus;
  fallbackReason: RunFallbackReason | null;
  metrics: RunMetrics | null;
  decisions: RunDecision[];
  benchmark: {
    caseId: string;
    category: string;
  } | null;
}

export type NewRunRecord = Omit<RunRecord, 'version' | 'id' | 'timestamp'>;

const SOURCES: readonly RunSource[] = ['live', 'benchmark'];
const MODES: readonly CompactionMode[] = ['jev', 'local'];
const STATUSES: readonly RunStatus[] = ['applied', 'fallback', 'passed', 'failed'];
const FALLBACKS: readonly RunFallbackReason[] = [
  'below_minimum_reduction',
  'missing_api_key',
  'request_timeout',
  'remote_error',
  'compaction_error',
];
const ACTIONS: readonly CallAction[] = ['keep', 'drop_result', 'drop_call'];
const REASONS: readonly CallDecision['reason'][] = [
  'pinned',
  'kept',
  'result_dropped',
  'call_dropped',
];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function integer(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function probability(value: unknown): number | null {
  return finite(value, 1);
}

function member<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : null;
}

function parseUsage(value: unknown): RunMetrics['apiUsage'] | undefined {
  if (value === null) return null;
  const raw = object(value);
  if (!raw) return undefined;
  const inputTokens = raw.inputTokens === null ? null : integer(raw.inputTokens);
  const outputTokens = raw.outputTokens === null ? null : integer(raw.outputTokens);
  if (inputTokens === null && raw.inputTokens !== null) return undefined;
  if (outputTokens === null && raw.outputTokens !== null) return undefined;
  return { inputTokens, outputTokens };
}

function parseMetrics(value: unknown): RunMetrics | null | undefined {
  if (value === null) return null;
  const raw = object(value);
  if (!raw) return undefined;
  const estimatedTokensBefore = integer(raw.estimatedTokensBefore);
  const estimatedTokensAfter = integer(raw.estimatedTokensAfter);
  const estimatedTokensSaved = integer(raw.estimatedTokensSaved);
  const estimatedReduction = probability(raw.estimatedReduction);
  const latencyMs = finite(raw.latencyMs);
  const requests = integer(raw.requests);
  const apiUsage = parseUsage(raw.apiUsage);
  const costUsd = raw.costUsd === null ? null : finite(raw.costUsd);
  const critical = raw.criticalRetention === null ? null : object(raw.criticalRetention);
  const criticalRequired = critical ? integer(critical.required) : null;
  const criticalRetained = critical ? integer(critical.retained) : null;
  const criticalRatio = critical ? probability(critical.ratio) : null;
  const taskPassed = raw.taskPassed;
  if (
    estimatedTokensBefore === null ||
    estimatedTokensAfter === null ||
    estimatedTokensSaved === null ||
    estimatedReduction === null ||
    latencyMs === null ||
    requests === null ||
    apiUsage === undefined ||
    (costUsd === null && raw.costUsd !== null) ||
    (raw.criticalRetention !== null &&
      (criticalRequired === null ||
        criticalRetained === null ||
        criticalRatio === null ||
        criticalRetained > criticalRequired)) ||
    (taskPassed !== null && typeof taskPassed !== 'boolean')
  ) return undefined;
  return {
    estimatedTokensBefore,
    estimatedTokensAfter,
    estimatedTokensSaved,
    estimatedReduction,
    latencyMs,
    requests,
    apiUsage,
    costUsd,
    criticalRetention:
      criticalRequired === null || criticalRetained === null || criticalRatio === null
        ? null
        : { required: criticalRequired, retained: criticalRetained, ratio: criticalRatio },
    taskPassed,
  };
}

function parseDecisions(value: unknown): RunDecision[] | null {
  if (!Array.isArray(value) || value.length > 5_000) return null;
  const decisions: RunDecision[] = [];
  for (const entry of value) {
    const raw = object(entry);
    if (!raw) return null;
    const action = member(raw.action, ACTIONS);
    const reason = member(raw.reason, REASONS);
    const keepCall = probability(raw.keepCall);
    const keepResult = probability(raw.keepResult);
    if (
      typeof raw.id !== 'string' || !/^t\d+$/.test(raw.id) ||
      typeof raw.tool !== 'string' || raw.tool.length === 0 || raw.tool.length > 120 ||
      !action || !reason || keepCall === null || keepResult === null
    ) return null;
    decisions.push({
      id: raw.id,
      tool: raw.tool,
      action,
      reason,
      keepCall,
      keepResult,
    });
  }
  return decisions;
}

/** Validates and copies only the safe record fields; unknown fields are discarded. */
export function parseRunRecord(value: unknown): RunRecord | null {
  const raw = object(value);
  if (!raw || raw.version !== RUN_RECORD_VERSION) return null;
  const source = member(raw.source, SOURCES);
  const mode = member(raw.mode, MODES);
  const status = member(raw.status, STATUSES);
  const fallbackReason = raw.fallbackReason === null
    ? null
    : member(raw.fallbackReason, FALLBACKS);
  const metrics = parseMetrics(raw.metrics);
  const decisions = parseDecisions(raw.decisions);
  const benchmark = raw.benchmark === null ? null : object(raw.benchmark);
  if (
    typeof raw.id !== 'string' || !/^run-[a-z0-9-]{8,80}$/.test(raw.id) ||
    typeof raw.timestamp !== 'string' || Number.isNaN(Date.parse(raw.timestamp)) ||
    !source || !mode || !status ||
    (fallbackReason === null && raw.fallbackReason !== null) ||
    metrics === undefined || !decisions ||
    (source === 'live' && !['applied', 'fallback'].includes(status)) ||
    (source === 'benchmark' && !['passed', 'failed'].includes(status)) ||
    (status === 'fallback' && !fallbackReason) ||
    (status !== 'fallback' && fallbackReason !== null) ||
    (status !== 'fallback' && metrics === null) ||
    (source === 'live' &&
      (benchmark !== null ||
        (metrics !== null &&
          (metrics.criticalRetention !== null || metrics.taskPassed !== null)))) ||
    (source === 'benchmark' &&
      (benchmark === null ||
        metrics === null ||
        metrics.criticalRetention === null ||
        metrics.taskPassed === null)) ||
    (status === 'passed' && metrics?.taskPassed !== true) ||
    (status === 'failed' && metrics?.taskPassed !== false)
  ) return null;
  let benchmarkMetadata: RunRecord['benchmark'] = null;
  if (benchmark) {
    if (
      typeof benchmark.caseId !== 'string' || !/^[a-z0-9-]{1,120}$/.test(benchmark.caseId) ||
      typeof benchmark.category !== 'string' || !/^[a-z0-9-]{1,120}$/.test(benchmark.category)
    ) return null;
    benchmarkMetadata = { caseId: benchmark.caseId, category: benchmark.category };
  }
  return {
    version: RUN_RECORD_VERSION,
    id: raw.id,
    timestamp: new Date(raw.timestamp).toISOString(),
    source,
    mode,
    status,
    fallbackReason,
    metrics,
    decisions,
    benchmark: benchmarkMetadata,
  };
}

export function createRunRecord(input: NewRunRecord): RunRecord {
  const record = parseRunRecord({
    ...input,
    version: RUN_RECORD_VERSION,
    id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
  });
  if (!record) throw new Error('Invalid run record');
  return record;
}

export function compactRunMetrics(result: CompactResult): RunMetrics {
  const { stats } = result;
  return {
    estimatedTokensBefore: stats.estimatedTokensBefore,
    estimatedTokensAfter: stats.estimatedTokensAfter,
    estimatedTokensSaved: stats.estimatedTokensSaved,
    estimatedReduction:
      stats.estimatedTokensBefore === 0
        ? 0
        : stats.estimatedTokensSaved / stats.estimatedTokensBefore,
    latencyMs: stats.ms,
    requests: stats.requests,
    apiUsage: stats.apiUsage,
    costUsd: stats.costUsd,
    criticalRetention: null,
    taskPassed: null,
  };
}

export function serializeRunRecord(value: unknown): string {
  const record = parseRunRecord(value);
  if (!record) throw new Error('Invalid run record');
  return JSON.stringify(record) + '\n';
}

/** Returns newest valid records first while ignoring blank and malformed lines. */
export function parseRunRecords(jsonl: string, limit = 100): RunRecord[] {
  const bounded = Math.min(MAX_RUN_HISTORY_RECORDS, Math.max(0, Math.floor(limit)));
  if (bounded === 0) return [];
  const records: RunRecord[] = [];
  const lines = jsonl.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0 && records.length < bounded; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const record = parseRunRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // A broken line must not hide the remaining history.
    }
  }
  return records;
}
