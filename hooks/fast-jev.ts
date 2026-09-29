import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import {
  CLOUD_UPLOAD_TIMEOUT_MS,
  cloudUploadConfig,
  uploadCloudRun,
} from '../src/cloud.js';
import { LocalAsker } from '../src/local.js';
import {
  isInstallId,
  newInstallId,
  TELEMETRY_NOTICE,
  TELEMETRY_TIMEOUT_MS,
  telemetryEnabled,
  telemetryUrl,
  toTelemetryEvent,
} from '../src/telemetry.js';
import {
  compactRunMetrics,
  createRunRecord,
  DEFAULT_RUN_HISTORY_PATH,
  serializeRunRecord,
  type RunFallbackReason,
  type RunRecord,
  type RunStatus,
} from '../src/run-record.js';
import {
  buildJevRequest,
  DEFAULT_MODEL,
  JEV_REQUEST_TIMEOUT_MS,
  parseJevResponse,
} from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  CompactionMode,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  mode: 'jev' as CompactionMode,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

type HookTimer = (ms: number, fn: () => void) => { cancel: () => void };

export function withHookTimeout<T>(
  request: Promise<T>,
  after: HookTimer,
  timeoutMs = JEV_REQUEST_TIMEOUT_MS,
  message = 'Jev request timed out',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = after(timeoutMs, () => reject(new Error(message)));
    request.then(
      (value) => { timer.cancel(); resolve(value); },
      (error: unknown) => { timer.cancel(); reject(error); },
    );
  });
}

export type HookConfig = CompactOptions & {
  mode: CompactionMode;
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  telemetry: boolean;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const mode = optionString(options, 'mode');
  const config: HookConfig = {
    ...numbers,
    mode: mode === 'local' ? 'local' : HOOK_DEFAULTS.mode,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    telemetry: options['telemetry'] !== false,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the selected compactor over a session transcript. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  let asker: JevAsker;
  if (config.mode === 'local') asker = new LocalAsker();
  else {
    if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    asker = jevAsker(fetchFn, config.apiKey, config.model);
  }
  const result = await compact(messages, asker, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

function fallbackReason(error: unknown): RunFallbackReason {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('typesafe_api_key')) return 'missing_api_key';
  if (message.includes('timed out')) return 'request_timeout';
  if (message.includes('jev request') || message.includes('jev response')) return 'remote_error';
  return 'compaction_error';
}

type RecordHost = {
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
  };
  session: {
    cwd: () => Promise<string>;
    repo: () => Promise<{ root: string } | null>;
  };
  ui: { log: (text: string) => void };
  env: { get: (name: string) => Promise<string | undefined> };
  http: { fetch: HookFetch };
  clock: { after: HookTimer };
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
};

/**
 * Sends one anonymous community event unless the user opted out. The first
 * call only creates the install ID and shows the notice; nothing is sent.
 */
export async function sendTelemetry(
  $: RecordHost,
  config: HookConfig,
  record: RunRecord,
): Promise<void> {
  const enabled = telemetryEnabled({
    option: config.telemetry,
    jevTelemetry: await $.env.get('JEV_TELEMETRY'),
    doNotTrack: await $.env.get('DO_NOT_TRACK'),
  });
  if (!enabled) return;
  const installId = await $.store.get('installId');
  if (!isInstallId(installId)) {
    await $.store.set('installId', newInstallId());
    $.ui.log(TELEMETRY_NOTICE);
    return;
  }
  const event = toTelemetryEvent(record, installId);
  if (!event) return;
  const url = telemetryUrl(await $.env.get('JEV_TELEMETRY_URL'));
  await withHookTimeout(
    $.http.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    }),
    (ms, fn) => $.clock.after(ms, fn),
    TELEMETRY_TIMEOUT_MS,
    'Telemetry timed out',
  );
}

async function uploadOwnRun($: RecordHost, record: RunRecord): Promise<void> {
  try {
    const enabled = await $.env.get('JEV_CLOUD_UPLOAD');
    if (enabled !== '1') return;
    const cloud = cloudUploadConfig(
      enabled,
      await $.env.get('JEV_CLOUD_INGEST_URL'),
      await $.env.get('JEV_CLOUD_INGEST_TOKEN'),
    );
    if (!cloud) return;
    await withHookTimeout(
      uploadCloudRun(record, cloud, (url, init) => $.http.fetch(url, init)),
      (ms, fn) => $.clock.after(ms, fn),
      CLOUD_UPLOAD_TIMEOUT_MS,
      'Cloud upload timed out',
    );
  } catch {
    $.ui.log('cloud upload unavailable; local history was saved');
  }
}

export async function recordLiveRun(
  $: RecordHost,
  config: HookConfig,
  status: RunStatus,
  reason: RunFallbackReason | null,
  result?: CompactResult,
): Promise<void> {
  let record: RunRecord;
  try {
    record = createRunRecord({
      source: 'live',
      mode: config.mode,
      status,
      fallbackReason: reason,
      metrics: result ? compactRunMetrics(result) : null,
      decisions: result?.decisions ?? [],
      benchmark: null,
    });
    const root = (await $.session.repo())?.root ?? await $.session.cwd();
    const path = root.replace(/[\\/]+$/, '') + '/' + DEFAULT_RUN_HISTORY_PATH;
    const previous = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    // ponytail: the hook API has whole-file writes only; use append when the host exposes it.
    await $.fs.write(path, previous + serializeRunRecord(record));
  } catch {
    $.ui.log('run history unavailable');
    return;
  }

  // Both uploads run together after the local write; telemetry failures stay silent.
  await Promise.all([
    uploadOwnRun($, record),
    sendTelemetry($, config, record).catch(() => undefined),
  ]);
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const config =
        configured.mode === 'local'
          ? configured
          : { ...configured, apiKey: await getApiKey($, configured) };
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await withHookTimeout(
          $.http.fetch(url, init),
          (ms, fn) => $.clock.after(ms, fn),
        );
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        await recordLiveRun(
          $,
          config,
          'fallback',
          'below_minimum_reduction',
          result,
        );
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      await recordLiveRun($, config, 'applied', null, result);
      return { messages };
    } catch (error) {
      await recordLiveRun($, configured, 'fallback', fallbackReason(error));
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
