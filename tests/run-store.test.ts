import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  appendRun,
  createRunRecord,
  readRuns,
  type NewRunRecord,
  type RunRecord,
} from '../src/index.js';

function benchmarkRun(caseId: string): NewRunRecord {
  return {
    source: 'benchmark',
    mode: 'local',
    status: 'passed',
    fallbackReason: null,
    metrics: {
      estimatedTokensBefore: 100,
      estimatedTokensAfter: 60,
      estimatedTokensSaved: 40,
      estimatedReduction: 0.4,
      latencyMs: 3,
      requests: 0,
      apiUsage: null,
      costUsd: null,
      criticalRetention: { required: 2, retained: 2, ratio: 1 },
      taskPassed: true,
    },
    decisions: [
      {
        id: 't1',
        tool: 'Read',
        action: 'drop_call',
        reason: 'call_dropped',
        keepCall: 0,
        keepResult: 0,
      },
    ],
    benchmark: { caseId, category: 'obsolete-read' },
  };
}

describe('run store', () => {
  it('appends safe JSONL and reads bounded history around malformed lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jev-runs-'));
    const path = join(directory, 'runs.jsonl');
    try {
      const first = Object.assign(createRunRecord(benchmarkRun('first-case')), {
        prompt: 'secret prompt',
        rawToolOutput: 'secret output',
      }) as RunRecord;
      const second = createRunRecord(benchmarkRun('second-case'));

      await appendRun(first, path);
      await appendFile(path, '{malformed}\n{"version":1}\n', 'utf8');
      await appendRun(second, path);

      const stored = await readFile(path, 'utf8');
      expect(stored).not.toMatch(/secret prompt|secret output/);
      expect(await readRuns(path, 1)).toEqual([second]);
      expect((await readRuns(path, 10)).map((record) => record.benchmark?.caseId)).toEqual([
        'second-case',
        'first-case',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a missing store', async () => {
    expect(await readRuns(join(tmpdir(), 'missing-jev-runs.jsonl'))).toEqual([]);
  });
});
