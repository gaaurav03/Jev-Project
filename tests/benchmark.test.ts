import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compact,
  formatBenchmarkTable,
  parseBenchmarkSuite,
  parseBenchmarkSuiteJson,
  reviewedVerification,
  scoreCriticalRetention,
  runBenchmarkSuite,
  type BenchmarkCase,
  type JevAsker,
  type Message,
} from '../src/index.js';

const fixtureJson = readFileSync(
  new URL('../bench/cases/core.json', import.meta.url),
  'utf8',
);

function fixture(id: string): BenchmarkCase {
  const found = parseBenchmarkSuiteJson(fixtureJson).cases.find((entry) => entry.id === id);
  if (!found) throw new Error('Missing fixture ' + id);
  return found;
}

function withoutTool(messages: readonly Message[], id: string): Message[] {
  return messages
    .map((message) => ({
      ...message,
      toolUses: message.toolUses.filter((tool) => tool.tool_use_id !== id),
      toolResults: message.toolResults?.filter((result) => result.tool_use_id !== id),
    }))
    .filter(
      (message) =>
        message.text.length > 0 ||
        message.toolUses.length > 0 ||
        (message.toolResults?.length ?? 0) > 0,
    );
}

describe('benchmark cases', () => {
  it('loads the four labelled synthetic fixtures', () => {
    const suite = parseBenchmarkSuiteJson(fixtureJson);
    expect(suite.version).toBe(1);
    expect(suite.cases.map((entry) => entry.category).sort()).toEqual([
      'obsolete-read',
      'protected-constraint',
      'repeated-test',
      'required-error',
    ]);
    expect(suite.cases.every((entry) => entry.verification === 'project-tests')).toBe(true);
  });

  it('rejects malformed, oversized, unlabelled, and unreviewed input', () => {
    expect(() => parseBenchmarkSuiteJson('{')).toThrow(/malformed/);
    expect(() => parseBenchmarkSuiteJson(fixtureJson, 10)).toThrow(/exceeds/);

    const unknownLabel = JSON.parse(fixtureJson) as {
      cases: Array<{ expectations: { criticalCalls: string[] }; verification: string }>;
    };
    unknownLabel.cases[0]!.expectations.criticalCalls = ['missing-call'];
    expect(() => parseBenchmarkSuite(unknownLabel)).toThrow(/unknown tool ID/);

    const contradictory = JSON.parse(fixtureJson) as {
      cases: Array<{
        expectations: { removableCalls: string[]; criticalResults: string[] };
      }>;
    };
    contradictory.cases[0]!.expectations.removableCalls = ['read-current'];
    expect(() => parseBenchmarkSuite(contradictory)).toThrow(/removable and critical/);

    const unreviewed = JSON.parse(fixtureJson) as {
      cases: Array<{ verification: string }>;
    };
    unreviewed.cases[0]!.verification = 'arbitrary-shell-command';
    expect(() => parseBenchmarkSuite(unreviewed)).toThrow(/not reviewed/);
  });

  it('resolves verification only through the reviewed command catalog', () => {
    const verification = reviewedVerification('project-tests');
    expect(verification.command).toMatch(/^npm(?:\.cmd)?$/);
    expect(verification.args).toEqual(['test']);
    expect(() => reviewedVerification('unsafe' as never)).toThrow(/not reviewed/);
  });

  it('reports removed critical calls and changed critical results', () => {
    const benchmark = fixture('required-error');

    expect(scoreCriticalRetention(benchmark, benchmark.messages)).toEqual({
      required: 2,
      retained: 2,
      ratio: 1,
      incorrectlyRemovedCalls: [],
      incorrectlyRemovedResults: [],
    });

    const withoutError = scoreCriticalRetention(
      benchmark,
      withoutTool(benchmark.messages, 'test-failure'),
    );
    expect(withoutError).toMatchObject({
      retained: 0,
      ratio: 0,
      incorrectlyRemovedCalls: ['test-failure'],
      incorrectlyRemovedResults: ['test-failure'],
    });

    const changedResult = structuredClone(benchmark.messages);
    const result = changedResult.flatMap((message) => message.toolResults ?? [])[0];
    if (!result) throw new Error('Fixture has no result');
    result.text = '[truncated]';
    expect(scoreCriticalRetention(benchmark, changedResult)).toMatchObject({
      retained: 1,
      ratio: 0.5,
      incorrectlyRemovedCalls: [],
      incorrectlyRemovedResults: ['test-failure'],
    });
  });

  it('does not penalize removal of a call labelled removable', () => {
    const benchmark = fixture('obsolete-read');
    const score = scoreCriticalRetention(
      benchmark,
      withoutTool(benchmark.messages, 'read-old'),
    );
    expect(score.ratio).toBe(1);
    expect(score.incorrectlyRemovedCalls).toEqual([]);
    expect(score.incorrectlyRemovedResults).toEqual([]);
  });
});
describe('benchmark runner', () => {
  it('aggregates Jev metrics, retention, task pass rate, and readable output', async () => {
    const suite = parseBenchmarkSuiteJson(fixtureJson);
    const asker: JevAsker = {
      async ask(_state, questions) {
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              { type: 'noul' as const, noul: 0.9 },
            ]),
          ),
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      },
    };
    const report = await runBenchmarkSuite(
      suite,
      (benchmark) =>
        compact(benchmark.messages, asker, {
          preserveRecentMessages: 1,
        }),
      async (_verification, benchmark) => benchmark.id !== 'required-error',
    );

    expect(report.summary).toMatchObject({
      cases: 4,
      criticalRequired: 8,
      criticalRetained: 8,
      criticalRetention: 1,
      tasksPassed: 3,
      taskPassRate: 0.75,
      requests: 4,
      apiUsage: { inputTokens: 40, outputTokens: 8 },
      costUsd: null,
    });
    expect(report.results).toHaveLength(4);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);

    const table = formatBenchmarkTable(report);
    expect(table).toContain('Est. reduction');
    expect(table).toContain('Usage in/out');
    expect(table).toContain('required-error');
    expect(table).toContain('TOTAL');
    expect(table).toContain('3/4');
  });
});