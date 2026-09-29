import type { RunRecord } from './run-record.js';

/** Must match `.claude-plugin/plugin.json`; a test keeps them in sync. */
export const PLUGIN_VERSION = '0.5.0';
export const DEFAULT_TELEMETRY_URL = 'https://jev-project-bay.vercel.app/api/telemetry';
export const TELEMETRY_TIMEOUT_MS = 3_000;
export const MAX_TELEMETRY_BYTES = 1024;
export const MAX_TELEMETRY_TOKENS = 5_000_000;
export const MAX_TELEMETRY_LATENCY_MS = 600_000;
export const TELEMETRY_NOTICE =
  'fast-jev-compaction shares anonymous usage counts (mode, status, token estimates) ' +
  'with the public community dashboard. No prompts, code, file names, or tool output ' +
  'are sent. Nothing is sent this session. Opt out: set JEV_TELEMETRY=0 or the ' +
  'plugin "telemetry" option to false.';

/** Exactly what one live compaction contributes to the community totals. */
export interface TelemetryEvent {
  v: 1;
  install_id: string;
  plugin_version: string;
  mode: RunRecord['mode'];
  status: 'applied' | 'fallback';
  tokens_before: number | null;
  tokens_after: number | null;
  latency_ms: number | null;
}

const FIELDS: readonly (keyof TelemetryEvent)[] = [
  'v', 'install_id', 'plugin_version', 'mode', 'status',
  'tokens_before', 'tokens_after', 'latency_ms',
];

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Telemetry is on unless the user opts out through config or environment. */
export function telemetryEnabled(input: {
  option?: boolean;
  jevTelemetry?: string;
  doNotTrack?: string;
}): boolean {
  if (input.option === false) return false;
  if (input.jevTelemetry !== undefined && OFF_VALUES.has(input.jevTelemetry.trim().toLowerCase())) {
    return false;
  }
  return input.doNotTrack?.trim() !== '1';
}

export function isInstallId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/** A random, anonymous install identifier; not derived from the user or machine. */
export function newInstallId(random: () => number = Math.random): string {
  const host = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = host.crypto?.randomUUID?.();
  if (uuid) return uuid.replaceAll('-', '');
  return Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
}

export function telemetryUrl(override: string | undefined): string {
  if (!override) return DEFAULT_TELEMETRY_URL;
  let parsed: URL;
  try { parsed = new URL(override); } catch { throw new Error('Telemetry URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || override.length > 2048) {
    throw new Error('Telemetry URL must be HTTPS');
  }
  return parsed.href;
}

function bounded(value: unknown, maximum: number): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

/** Validates the exact anonymous event accepted by the telemetry endpoint. */
export function parseTelemetryEvent(value: unknown): TelemetryEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key as keyof TelemetryEvent))) {
    return null;
  }
  const before = bounded(raw.tokens_before, MAX_TELEMETRY_TOKENS);
  const after = bounded(raw.tokens_after, MAX_TELEMETRY_TOKENS);
  const latency = bounded(raw.latency_ms, MAX_TELEMETRY_LATENCY_MS);
  const metrics = [before, after, latency];
  const none = metrics.every((entry) => entry === null);
  const all = metrics.every((entry) => typeof entry === 'number');
  if (
    raw.v !== 1 ||
    !isInstallId(raw.install_id) ||
    typeof raw.plugin_version !== 'string' ||
    !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(raw.plugin_version) ||
    (raw.mode !== 'jev' && raw.mode !== 'local') ||
    (raw.status !== 'applied' && raw.status !== 'fallback') ||
    metrics.some((entry) => entry === undefined) ||
    (!none && !all) ||
    (all && after! > before!) ||
    (raw.status === 'applied' && none)
  ) return null;
  return {
    v: 1,
    install_id: raw.install_id,
    plugin_version: raw.plugin_version,
    mode: raw.mode,
    status: raw.status,
    tokens_before: before!,
    tokens_after: after!,
    latency_ms: latency!,
  };
}

/** Reduces a live run record to its anonymous event; benchmark runs are never sent. */
export function toTelemetryEvent(record: RunRecord, installId: string): TelemetryEvent | null {
  if (record.source !== 'live' || (record.status !== 'applied' && record.status !== 'fallback')) {
    return null;
  }
  const metrics = record.metrics;
  return parseTelemetryEvent({
    v: 1,
    install_id: installId,
    plugin_version: PLUGIN_VERSION,
    mode: record.mode,
    status: record.status,
    tokens_before: metrics ? Math.min(metrics.estimatedTokensBefore, MAX_TELEMETRY_TOKENS) : null,
    tokens_after: metrics ? Math.min(metrics.estimatedTokensAfter, MAX_TELEMETRY_TOKENS) : null,
    latency_ms: metrics ? Math.min(Math.round(metrics.latencyMs), MAX_TELEMETRY_LATENCY_MS) : null,
  });
}
