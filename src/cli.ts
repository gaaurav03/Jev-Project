import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import {
  MAX_BENCHMARK_BYTES,
  formatBenchmarkTable,
  parseBenchmarkSuiteJson,
  runBenchmarkSuite,
  type ReviewedVerification,
} from './benchmark.js';
import {
  CLOUD_UPLOAD_TIMEOUT_MS,
  cloudUploadConfig,
  uploadCloudRun,
  type CloudUploadConfig,
} from './cloud.js';
import { compactMessages } from './messages.js';
import { createRunRecord } from './run-record.js';
import { appendRun } from './run-store.js';
import type { CompactionMode } from './types.js';

type CliOptions = {
  casesPath: string;
  json: boolean;
  help: boolean;
  mode: CompactionMode | 'both';
};

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    casesPath: resolve('bench/cases/core.json'),
    json: false,
    help: false,
    mode: 'both',
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--mode') {
      const mode = args[index + 1];
      if (mode !== 'jev' && mode !== 'local' && mode !== 'both') {
        throw new Error('--mode requires jev, local, or both');
      }
      options.mode = mode;
      index += 1;
    } else if (argument === '--cases') {
      const path = args[index + 1];
      if (!path) throw new Error('--cases requires a file path');
      options.casesPath = resolve(path);
      index += 1;
    } else {
      throw new Error('Unknown benchmark option: ' + argument);
    }
  }
  return options;
}

function runVerification(verification: ReviewedVerification): Promise<boolean> {
  return new Promise((resolveResult) => {
    const child = spawn(verification.command, verification.args, {
      shell: process.platform === 'win32',
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => resolveResult(false));
    child.once('exit', (code) => resolveResult(code === 0));
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: npm run bench -- [--json] [--mode jev|local|both] [--cases path/to/cases.json]\n',
    );
    return;
  }

  const file = await stat(options.casesPath);
  if (file.size > MAX_BENCHMARK_BYTES) {
    throw new Error('Benchmark JSON exceeds ' + MAX_BENCHMARK_BYTES + ' bytes');
  }
  const suite = parseBenchmarkSuiteJson(await readFile(options.casesPath, 'utf8'));
  let cloudConfig: CloudUploadConfig | null = null;
  let cloudWarningShown = false;
  try {
    cloudConfig = cloudUploadConfig(
      process.env.JEV_CLOUD_UPLOAD,
      process.env.JEV_CLOUD_INGEST_URL,
      process.env.JEV_CLOUD_INGEST_TOKEN,
    );
  } catch {
    process.stderr.write('Cloud upload disabled: invalid configuration\n');
  }
  const modes: CompactionMode[] =
    options.mode === 'both' ? ['jev', 'local'] : [options.mode];
  const verificationRuns = new Map<string, Promise<boolean>>();
  const verify = (verification: ReviewedVerification): Promise<boolean> => {
    const key = [verification.command, ...verification.args].join('\0');
    const existing = verificationRuns.get(key);
    if (existing) return existing;
    const run = runVerification(verification);
    verificationRuns.set(key, run);
    return run;
  };
  const reports = await Promise.all(
    modes.map((mode) =>
      runBenchmarkSuite(
        suite,
        (benchmark) =>
          compactMessages(benchmark.messages, {
            mode,
            preserveRecentMessages: 1,
          }),
        (verification) => verify(verification),
        mode,
      ),
    ),
  );
  for (const report of reports) {
    for (const result of report.results) {
      const record = createRunRecord({
        source: 'benchmark',
        mode: report.mode,
        status: result.taskPassed ? 'passed' : 'failed',
        fallbackReason: null,
        metrics: {
          estimatedTokensBefore: result.estimatedTokensBefore,
          estimatedTokensAfter: result.estimatedTokensAfter,
          estimatedTokensSaved: result.estimatedTokensSaved,
          estimatedReduction: result.estimatedReduction,
          latencyMs: result.latencyMs,
          requests: result.requests,
          apiUsage: result.apiUsage,
          costUsd: result.costUsd,
          criticalRetention: {
            required: result.criticalRetention.required,
            retained: result.criticalRetention.retained,
            ratio: result.criticalRetention.ratio,
          },
          taskPassed: result.taskPassed,
        },
        decisions: result.decisions,
        benchmark: { caseId: result.id, category: result.category },
      });
      await appendRun(record);
      if (cloudConfig) {
        try {
          await uploadCloudRun(record, cloudConfig, async (url, init) =>
            fetch(url, { ...init, signal: AbortSignal.timeout(CLOUD_UPLOAD_TIMEOUT_MS) }));
        } catch {
          cloudConfig = null;
          if (!cloudWarningShown) {
            process.stderr.write('Cloud upload unavailable; local history was saved\n');
            cloudWarningShown = true;
          }
        }
      }
    }
  }
  const output = options.json
    ? JSON.stringify(reports.length === 1 ? reports[0] : { version: 1, reports }, null, 2)
    : reports
        .map((report) => report.mode.toUpperCase() + '\n' + formatBenchmarkTable(report))
        .join('\n\n');

  process.stdout.write(output + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    'Benchmark failed: ' + (error instanceof Error ? error.message : String(error)) + '\n',
  );
  process.exitCode = 1;
});