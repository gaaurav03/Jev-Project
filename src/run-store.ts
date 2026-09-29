import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  DEFAULT_RUN_HISTORY_PATH,
  parseRunRecords,
  serializeRunRecord,
  type RunRecord,
} from './run-record.js';

export const MAX_RUN_HISTORY_BYTES = 4 * 1024 * 1024;

export async function appendRun(
  record: RunRecord,
  path = DEFAULT_RUN_HISTORY_PATH,
): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, serializeRunRecord(record), 'utf8');
}

export async function readRuns(
  path = DEFAULT_RUN_HISTORY_PATH,
  limit = 100,
): Promise<RunRecord[]> {
  const target = resolve(path);
  let handle;
  try {
    handle = await open(target, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const bytes = Math.min(size, MAX_RUN_HISTORY_BYTES);
    const start = size - bytes;
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    }
    return parseRunRecords(text, limit);
  } finally {
    await handle.close();
  }
}
