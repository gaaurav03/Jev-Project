import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RUN_HISTORY_PATH,
  type RunRecord,
  type RunStatus,
} from './run-record.js';
import { readRuns } from './run-store.js';
import type { CompactionMode } from './types.js';

export const DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 4310;
export const MAX_API_RESPONSE_BYTES = 1024 * 1024;
export const MAX_API_RUNS = 200;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const DASHBOARD_DIRECTORY = fileURLToPath(new URL('../dashboard/', import.meta.url));
const DASHBOARD_ASSETS = new Map<string, [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
]);

const MODES: readonly CompactionMode[] = ['jev', 'local'];
const STATUSES: readonly RunStatus[] = ['applied', 'fallback', 'passed', 'failed'];

export interface DashboardModeSummary {
  runs: number;
  estimatedTokensSaved: number;
  averageReduction: number | null;
  averageLatencyMs: number | null;
  criticalRetention: number | null;
  taskPassRate: number | null;
  requests: number;
  apiUsage: { inputTokens: number | null; outputTokens: number | null } | null;
  knownCostUsd: number | null;
}

export interface DashboardSummary {
  generatedAt: string;
  totalRuns: number;
  cards: Omit<DashboardModeSummary, 'runs' | 'averageLatencyMs'>;
  comparison: Record<CompactionMode, DashboardModeSummary>;
  trends: Array<{
    id: string;
    timestamp: string;
    source: RunRecord['source'];
    mode: CompactionMode;
    estimatedReduction: number;
    latencyMs: number;
  }>;
}

export type DashboardSummaryRun = Pick<
  RunRecord,
  'id' | 'timestamp' | 'source' | 'mode' | 'metrics'
>;

export type DashboardRun = Omit<RunRecord, 'decisions'> & {
  decisionCounts: { kept: number; truncated: number; removed: number };
};

export interface DashboardServerOptions {
  historyPath?: string;
  port?: number;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

function aggregate(records: readonly DashboardSummaryRun[]): DashboardModeSummary {
  const metrics = records.flatMap((record) => record.metrics ? [record.metrics] : []);
  const critical = metrics.flatMap((entry) =>
    entry.criticalRetention ? [entry.criticalRetention] : [],
  );
  const required = critical.reduce((sum, entry) => sum + entry.required, 0);
  const retained = critical.reduce((sum, entry) => sum + entry.retained, 0);
  const tasks = metrics.flatMap((entry) =>
    entry.taskPassed === null ? [] : [entry.taskPassed],
  );
  const inputTokens = sumKnown(
    metrics.map((entry) => entry.apiUsage?.inputTokens ?? null),
  );
  const outputTokens = sumKnown(
    metrics.map((entry) => entry.apiUsage?.outputTokens ?? null),
  );
  return {
    runs: records.length,
    estimatedTokensSaved: metrics.reduce(
      (sum, entry) => sum + entry.estimatedTokensSaved,
      0,
    ),
    averageReduction: average(metrics.map((entry) => entry.estimatedReduction)),
    averageLatencyMs: average(metrics.map((entry) => entry.latencyMs)),
    criticalRetention: required === 0 ? null : retained / required,
    taskPassRate:
      tasks.length === 0
        ? null
        : tasks.filter(Boolean).length / tasks.length,
    requests: metrics.reduce((sum, entry) => sum + entry.requests, 0),
    apiUsage:
      inputTokens === null && outputTokens === null
        ? null
        : { inputTokens, outputTokens },
    knownCostUsd: sumKnown(metrics.map((entry) => entry.costUsd)),
  };
}

export function summarizeRuns(records: readonly DashboardSummaryRun[]): DashboardSummary {
  const all = aggregate(records);
  return {
    generatedAt: new Date().toISOString(),
    totalRuns: records.length,
    cards: {
      estimatedTokensSaved: all.estimatedTokensSaved,
      averageReduction: all.averageReduction,
      criticalRetention: all.criticalRetention,
      taskPassRate: all.taskPassRate,
      requests: all.requests,
      apiUsage: all.apiUsage,
      knownCostUsd: all.knownCostUsd,
    },
    comparison: {
      jev: aggregate(records.filter((record) => record.mode === 'jev')),
      local: aggregate(records.filter((record) => record.mode === 'local')),
    },
    trends: records
      .flatMap((record) =>
        record.metrics
          ? [{
              id: record.id,
              timestamp: record.timestamp,
              source: record.source,
              mode: record.mode,
              estimatedReduction: record.metrics.estimatedReduction,
              latencyMs: record.metrics.latencyMs,
            }]
          : [],
      )
      .slice(0, 100)
      .reverse(),
  };
}

function listRun(record: RunRecord): DashboardRun {
  const { decisions: _decisions, ...safe } = record;
  return {
    ...safe,
    decisionCounts: {
      kept: record.decisions.filter((decision) => decision.action === 'keep').length,
      truncated: record.decisions.filter((decision) => decision.action === 'drop_result').length,
      removed: record.decisions.filter((decision) => decision.action === 'drop_call').length,
    },
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  let body = JSON.stringify(value);
  let code = status;
  if (Buffer.byteLength(body) > MAX_API_RESPONSE_BYTES) {
    code = 413;
    body = JSON.stringify({ error: 'Response too large' });
  }
  response.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

async function sendAsset(
  response: ServerResponse,
  fileName: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(join(DASHBOARD_DIRECTORY, fileName));
  if (body.byteLength > MAX_API_RESPONSE_BYTES) {
    sendJson(response, 413, { error: 'Response too large' });
    return;
  }
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Length': body.byteLength,
    'Content-Type': contentType,
  });
  response.end(body);
}

function one(search: URLSearchParams, name: string): string | undefined {
  const values = search.getAll(name);
  if (values.length > 1) throw new HttpError(400, `Duplicate ${name} filter`);
  return values[0];
}

function dateFilter(value: string | undefined, endOfDay: boolean): number | undefined {
  if (value === undefined) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  if ((!dateOnly && !dateTime) || value.length > 64) {
    throw new HttpError(400, 'Invalid date filter');
  }
  const normalized = dateOnly
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value;
  const parsed = Date.parse(normalized);
  const calendarDate = value.slice(0, 10);
  if (
    Number.isNaN(parsed) ||
    new Date(Date.parse(`${calendarDate}T00:00:00.000Z`)).toISOString().slice(0, 10) !== calendarDate
  ) throw new HttpError(400, 'Invalid date filter');
  return parsed;
}

export interface DashboardFilters {
  mode?: CompactionMode;
  status?: RunStatus;
  from?: number;
  to?: number;
  limit: number;
}

export function parseDashboardFilters(url: URL): DashboardFilters {
  const allowed = new Set(['mode', 'status', 'from', 'to', 'limit']);
  for (const name of url.searchParams.keys()) {
    if (!allowed.has(name)) throw new HttpError(400, 'Unknown run filter');
  }
  const mode = one(url.searchParams, 'mode');
  const status = one(url.searchParams, 'status');
  if (mode !== undefined && !MODES.includes(mode as CompactionMode)) {
    throw new HttpError(400, 'Invalid mode filter');
  }
  if (status !== undefined && !STATUSES.includes(status as RunStatus)) {
    throw new HttpError(400, 'Invalid status filter');
  }
  const from = dateFilter(one(url.searchParams, 'from'), false);
  const to = dateFilter(one(url.searchParams, 'to'), true);
  if (from !== undefined && to !== undefined && from > to) {
    throw new HttpError(400, 'Invalid date range');
  }
  const rawLimit = one(url.searchParams, 'limit');
  if (rawLimit !== undefined && !/^[1-9]\d{0,2}$/.test(rawLimit)) {
    throw new HttpError(400, 'Invalid limit');
  }
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (limit > MAX_API_RUNS) throw new HttpError(400, 'Invalid limit');
  return {
    ...(mode === undefined ? {} : { mode: mode as CompactionMode }),
    ...(status === undefined ? {} : { status: status as RunStatus }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    limit,
  };
}

function filteredRuns(records: readonly RunRecord[], url: URL): {
  records: RunRecord[];
  limit: number;
} {
  const filters = parseDashboardFilters(url);
  return {
    limit: filters.limit,
    records: records.filter((record) => {
      const time = Date.parse(record.timestamp);
      return (
        (filters.mode === undefined || record.mode === filters.mode) &&
        (filters.status === undefined || record.status === filters.status) &&
        (filters.from === undefined || time >= filters.from) &&
        (filters.to === undefined || time <= filters.to)
      );
    }),
  };
}
function requireNoQuery(url: URL): void {
  if ([...url.searchParams].length > 0) throw new HttpError(400, 'Query not supported');
}

export function createDashboardServer(
  options: Pick<DashboardServerOptions, 'historyPath'> = {},
): Server {
  const historyPath = options.historyPath ?? DEFAULT_RUN_HISTORY_PATH;
  return createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        sendJson(response, 405, { error: 'Method not allowed' });
        return;
      }
      if (!request.url || request.url.length > 2048) {
        sendJson(response, 414, { error: 'Request URI too long' });
        return;
      }
      const url = new URL(request.url, `http://${DASHBOARD_HOST}`);
      const asset = DASHBOARD_ASSETS.get(url.pathname);
      if (asset) {
        await sendAsset(response, ...asset);
        return;
      }
      if (url.pathname === '/api/summary') {
        requireNoQuery(url);
        sendJson(response, 200, summarizeRuns(await readRuns(historyPath, 1_000)));
        return;
      }
      if (url.pathname === '/api/runs') {
        const filtered = filteredRuns(await readRuns(historyPath, 1_000), url);
        sendJson(response, 200, {
          runs: filtered.records.slice(0, filtered.limit).map(listRun),
          returned: Math.min(filtered.records.length, filtered.limit),
          available: filtered.records.length,
          limit: filtered.limit,
        });
        return;
      }
      if (url.pathname.startsWith('/api/runs/')) {
        requireNoQuery(url);
        const id = url.pathname.slice('/api/runs/'.length);
        if (!/^run-[a-z0-9-]{8,80}$/.test(id)) {
          throw new HttpError(400, 'Invalid run ID');
        }
        const run = (await readRuns(historyPath, 1_000)).find((record) => record.id === id);
        sendJson(response, run ? 200 : 404, run ? { run } : { error: 'Run not found' });
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(
        response,
        error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'Unable to read run history' },
      );
    }
  });
}

export async function startDashboardServer(
  options: DashboardServerOptions = {},
): Promise<Server> {
  const port = options.port ?? DEFAULT_DASHBOARD_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Dashboard port must be an integer from 0 to 65535');
  }
  const server = createDashboardServer(options);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, DASHBOARD_HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
  return server;
}
