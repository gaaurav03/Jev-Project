import type {
  CompactionState,
  HistoryToolCall,
  JevAsker,
  JevQuestions,
  JevResponse,
} from './types.js';

const READ_TOOLS = new Set(['read']);

function structuredCalls(state: string | object): HistoryToolCall[] {
  if (!('history' in Object(state))) return [];
  const history = (state as CompactionState).history;
  if (!Array.isArray(history)) return [];
  return history.flatMap((entry) =>
    (entry.tool_calls ?? []).filter(
      (call): call is HistoryToolCall => typeof call === 'object',
    ),
  );
}

/** Conservatively removes only old, successful duplicate reads. */
export class LocalAsker implements JevAsker {
  readonly isRemote = false;

  async ask(state: string | object, questions: JevQuestions): Promise<JevResponse> {
    const calls = structuredCalls(state);
    const latest = new Map<string, HistoryToolCall>();
    for (const call of calls) {
      if (READ_TOOLS.has(call.tool.toLowerCase())) {
        latest.set(call.tool.toLowerCase() + '\0' + call.input, call);
      }
    }
    const removable = new Set(
      calls
        .filter((call) => {
          const key = call.tool.toLowerCase() + '\0' + call.input;
          const newer = latest.get(key);
          return (
            READ_TOOLS.has(call.tool.toLowerCase()) &&
            !call.input.endsWith('…') &&
            !call.result.startsWith('error,') &&
            newer !== undefined &&
            newer.id !== call.id &&
            !newer.result.startsWith('error,')
          );
        })
        .map((call) => call.id),
    );
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map((key) => {
          const id = key.replace(/^(call|result)_/, '');
          return [key, { type: 'noul', noul: removable.has(id) ? 0 : 1 }];
        }),
      ),
    };
  }
}
