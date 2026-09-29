import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact.js';
import { LocalAsker } from './local.js';
import type {
  CompactOptions,
  CompactResult,
  CompactionMode,
  Message,
} from './types.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions & {
  mode?: CompactionMode;
};

/** `compact` with a `JevClient` built from the options (key from `TYPESAFE_API_KEY` by default). */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(
    messages,
    options.mode === 'local' ? new LocalAsker() : new JevClient(options),
    options,
  );
}
