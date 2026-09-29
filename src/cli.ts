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
import { compactMessages } from './messages.js';

type CliOptions = {
  casesPath: string;
  json: boolean;
  help: boolean;
};

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    casesPath: resolve('bench/cases/core.json'),
    json: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--cases') {
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
      shell: false,
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
      'Usage: npm run bench -- [--json] [--cases path/to/cases.json]\n',
    );
    return;
  }

  const file = await stat(options.casesPath);
  if (file.size > MAX_BENCHMARK_BYTES) {
    throw new Error('Benchmark JSON exceeds ' + MAX_BENCHMARK_BYTES + ' bytes');
  }
  const suite = parseBenchmarkSuiteJson(await readFile(options.casesPath, 'utf8'));
  const report = await runBenchmarkSuite(
    suite,
    (benchmark) =>
      compactMessages(benchmark.messages, {
        preserveRecentMessages: 1,
      }),
    (verification) => runVerification(verification),
  );

  process.stdout.write(
    (options.json ? JSON.stringify(report, null, 2) : formatBenchmarkTable(report)) + '\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    'Benchmark failed: ' + (error instanceof Error ? error.message : String(error)) + '\n',
  );
  process.exitCode = 1;
});