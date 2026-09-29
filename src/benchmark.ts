import type { Message } from './types.js';

export const MAX_BENCHMARK_BYTES = 1_000_000;

const CATEGORIES = [
  'obsolete-read',
  'required-error',
  'repeated-test',
  'protected-constraint',
] as const;

const REVIEWED_VERIFICATIONS = {
  'project-tests': ['test'],
} as const;

export type BenchmarkCategory = (typeof CATEGORIES)[number];
export type VerificationId = keyof typeof REVIEWED_VERIFICATIONS;

export interface BenchmarkExpectations {
  removableCalls: string[];
  criticalCalls: string[];
  criticalResults: string[];
}

export interface BenchmarkCase {
  id: string;
  name: string;
  category: BenchmarkCategory;
  messages: Message[];
  expectations: BenchmarkExpectations;
  verification: VerificationId;
}

export interface BenchmarkSuite {
  version: 1;
  cases: BenchmarkCase[];
}

export interface CriticalRetentionScore {
  required: number;
  retained: number;
  ratio: number;
  incorrectlyRemovedCalls: string[];
  incorrectlyRemovedResults: string[];
}

export interface ReviewedVerification {
  command: string;
  args: readonly string[];
}

function invalid(path: string, message: string): never {
  throw new Error('Invalid benchmark at ' + path + ': ' + message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(path, 'expected a non-empty string');
  }
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, 'expected an array');
  const values = value.map((entry, index) => string(entry, path + '[' + index + ']'));
  if (new Set(values).size !== values.length) invalid(path, 'contains duplicate IDs');
  return values;
}

function validateMessages(
  value: unknown,
  path: string,
): { messages: Message[]; callIds: Set<string>; resultIds: Set<string> } {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(path, 'expected at least one message');
  }

  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const [messageIndex, rawMessage] of value.entries()) {
    const messagePath = path + '[' + messageIndex + ']';
    const message = object(rawMessage, messagePath);
    if (message.role !== 'user' && message.role !== 'assistant') {
      invalid(messagePath + '.role', 'expected user or assistant');
    }
    if (typeof message.text !== 'string') invalid(messagePath + '.text', 'expected a string');
    if (!Array.isArray(message.toolUses)) {
      invalid(messagePath + '.toolUses', 'expected an array');
    }

    for (const [toolIndex, rawTool] of message.toolUses.entries()) {
      const toolPath = messagePath + '.toolUses[' + toolIndex + ']';
      const tool = object(rawTool, toolPath);
      const id = string(tool.tool_use_id, toolPath + '.tool_use_id');
      string(tool.tool, toolPath + '.tool');
      object(tool.input, toolPath + '.input');
      if (tool.text !== undefined && typeof tool.text !== 'string') {
        invalid(toolPath + '.text', 'expected a string');
      }
      if (tool.isError !== undefined && typeof tool.isError !== 'boolean') {
        invalid(toolPath + '.isError', 'expected a boolean');
      }
      if (callIds.has(id)) invalid(toolPath + '.tool_use_id', 'duplicate tool call ID');
      callIds.add(id);
    }

    if (message.toolResults !== undefined) {
      if (!Array.isArray(message.toolResults)) {
        invalid(messagePath + '.toolResults', 'expected an array');
      }
      for (const [resultIndex, rawResult] of message.toolResults.entries()) {
        const resultPath = messagePath + '.toolResults[' + resultIndex + ']';
        const result = object(rawResult, resultPath);
        const id = string(result.tool_use_id, resultPath + '.tool_use_id');
        if (typeof result.text !== 'string') invalid(resultPath + '.text', 'expected a string');
        if (result.isError !== undefined && typeof result.isError !== 'boolean') {
          invalid(resultPath + '.isError', 'expected a boolean');
        }
        if (resultIds.has(id)) invalid(resultPath + '.tool_use_id', 'duplicate tool result ID');
        resultIds.add(id);
      }
    }
  }

  for (const id of resultIds) {
    if (!callIds.has(id)) invalid(path, 'tool result ' + id + ' has no matching call');
  }
  return { messages: value as Message[], callIds, resultIds };
}

function requireIds(ids: readonly string[], available: ReadonlySet<string>, path: string): void {
  for (const id of ids) {
    if (!available.has(id)) invalid(path, 'unknown tool ID ' + id);
  }
}

function parseCase(value: unknown, path: string): BenchmarkCase {
  const raw = object(value, path);
  const id = string(raw.id, path + '.id');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    invalid(path + '.id', 'use lowercase words separated by hyphens');
  }
  const name = string(raw.name, path + '.name');
  if (!CATEGORIES.includes(raw.category as BenchmarkCategory)) {
    invalid(path + '.category', 'unknown category');
  }
  const category = raw.category as BenchmarkCategory;
  const { messages, callIds, resultIds } = validateMessages(raw.messages, path + '.messages');

  const rawExpectations = object(raw.expectations, path + '.expectations');
  const expectations: BenchmarkExpectations = {
    removableCalls: stringList(
      rawExpectations.removableCalls,
      path + '.expectations.removableCalls',
    ),
    criticalCalls: stringList(
      rawExpectations.criticalCalls,
      path + '.expectations.criticalCalls',
    ),
    criticalResults: stringList(
      rawExpectations.criticalResults,
      path + '.expectations.criticalResults',
    ),
  };
  requireIds(expectations.removableCalls, callIds, path + '.expectations.removableCalls');
  requireIds(expectations.criticalCalls, callIds, path + '.expectations.criticalCalls');
  requireIds(expectations.criticalResults, resultIds, path + '.expectations.criticalResults');
  for (const id of expectations.removableCalls) {
    if (
      expectations.criticalCalls.includes(id) ||
      expectations.criticalResults.includes(id)
    ) {
      invalid(path + '.expectations', id + ' cannot be removable and critical');
    }
  }

  const verification = string(raw.verification, path + '.verification');
  if (!Object.prototype.hasOwnProperty.call(REVIEWED_VERIFICATIONS, verification)) {
    invalid(path + '.verification', 'command is not reviewed');
  }

  return {
    id,
    name,
    category,
    messages,
    expectations,
    verification: verification as VerificationId,
  };
}

export function parseBenchmarkSuite(value: unknown): BenchmarkSuite {
  const raw = object(value, '$');
  if (raw.version !== 1) invalid('$.version', 'expected version 1');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    invalid('$.cases', 'expected at least one case');
  }
  const cases = raw.cases.map((entry, index) => parseCase(entry, '$.cases[' + index + ']'));
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    invalid('$.cases', 'contains duplicate case IDs');
  }
  return { version: 1, cases };
}

export function parseBenchmarkSuiteJson(
  json: string,
  maxBytes: number = MAX_BENCHMARK_BYTES,
): BenchmarkSuite {
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new Error('Benchmark JSON exceeds ' + maxBytes + ' bytes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Benchmark JSON is malformed');
  }
  return parseBenchmarkSuite(parsed);
}

export function reviewedVerification(id: VerificationId): ReviewedVerification {
  if (!Object.prototype.hasOwnProperty.call(REVIEWED_VERIFICATIONS, id)) {
    throw new Error('Verification command is not reviewed');
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [...REVIEWED_VERIFICATIONS[id]],
  };
}

export function scoreCriticalRetention(
  benchmark: Pick<BenchmarkCase, 'messages' | 'expectations'>,
  output: readonly Message[],
): CriticalRetentionScore {
  const outputCalls = new Set(
    output.flatMap((message) => message.toolUses.map((tool) => tool.tool_use_id)),
  );
  const originalResults = new Map(
    benchmark.messages.flatMap((message) =>
      (message.toolResults ?? []).map((result) => [result.tool_use_id, result.text] as const),
    ),
  );
  const outputResults = new Map(
    output.flatMap((message) =>
      (message.toolResults ?? []).map((result) => [result.tool_use_id, result.text] as const),
    ),
  );

  const incorrectlyRemovedCalls = benchmark.expectations.criticalCalls.filter(
    (id) => !outputCalls.has(id),
  );
  const incorrectlyRemovedResults = benchmark.expectations.criticalResults.filter(
    (id) => !outputResults.has(id) || outputResults.get(id) !== originalResults.get(id),
  );
  const required =
    benchmark.expectations.criticalCalls.length +
    benchmark.expectations.criticalResults.length;
  const retained =
    required - incorrectlyRemovedCalls.length - incorrectlyRemovedResults.length;

  return {
    required,
    retained,
    ratio: required === 0 ? 1 : retained / required,
    incorrectlyRemovedCalls,
    incorrectlyRemovedResults,
  };
}