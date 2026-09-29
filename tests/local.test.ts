import { describe, expect, it } from 'vitest';

import { compactMessages, type Message } from '../src/index.js';

function call(id: string, tool: string, input: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: id, tool, input }],
  };
}

function result(id: string, text: string, isError = false): Message {
  return {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: id, text, isError }],
  };
}

describe('local mode', () => {
  it('deterministically drops only old successful duplicate reads without a key or network', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'Update the parser safely.', toolUses: [] },
      call('read-old', 'Read', { file_path: 'src/parser.ts' }),
      result('read-old', 'old contents'),
      call('edit', 'Edit', { file_path: 'src/parser.ts', old: 'a', new: 'b' }),
      result('edit', 'updated'),
      call('error', 'Bash', { command: 'npm test' }),
      result('error', 'FAIL parser.test.ts', true),
      call('uncertain', 'Bash', { command: 'git status' }),
      result('uncertain', 'clean'),
      call('read-current', 'Read', { file_path: 'src/parser.ts' }),
      result('read-current', 'current contents'),
      { role: 'assistant', text: 'Ready.', toolUses: [] },
    ];
    let networkCalls = 0;
    const run = () =>
      compactMessages(messages, {
        mode: 'local',
        preserveRecentMessages: 1,
        fetch: async () => {
          networkCalls += 1;
          throw new Error('network must not run');
        },
      });

    const first = await run();
    const second = await run();

    expect(networkCalls).toBe(0);
    expect(first.decisions.map(({ tool, action }) => [tool, action])).toEqual([
      ['Read', 'drop_call'],
      ['Edit', 'keep'],
      ['Bash', 'keep'],
      ['Bash', 'keep'],
      ['Read', 'keep'],
    ]);
    expect(first.stats).toMatchObject({ requests: 0, apiUsage: null, costUsd: null });
    expect(first.messages).toEqual(second.messages);
    expect(first.decisions).toEqual(second.decisions);
  });
});
