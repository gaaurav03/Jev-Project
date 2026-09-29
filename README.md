# fast-jev-plus

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install github:gaaurav03/Jev-Project
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-plus';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
// Offline alternative: compactMessages(transcript, { mode: 'local' })
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.15) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `jev` | `jev` for TypeSafe scoring, or `local` for deterministic offline scoring |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`); unused in local mode |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add gaaurav03/Jev-Project
claude plugin install fast-jev-plus@fast-jev-plus
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-plus: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Benchmark

The benchmark runs the same labelled cases through Jev and local mode by
default, checks critical call/result retention, runs only reviewed verification
commands, and reports estimated reduction, task pass rate, latency, requests,
API usage, and known cost. Cost remains unknown when verified pricing is
unavailable.

PowerShell:

~~~powershell
$env:TYPESAFE_API_KEY = 'your-key'
npm.cmd run bench
npm.cmd run bench -- --json
npm.cmd run bench -- --mode local
npm.cmd run bench -- --mode jev
npm.cmd run bench -- --cases bench/cases/core.json
~~~

macOS/Linux:

~~~sh
TYPESAFE_API_KEY='your-key' npm run bench
npm run bench -- --json
npm run bench -- --mode local
~~~

Table output is the default; `--json` emits the complete machine-readable report.
`--mode local` needs no API key or network; `--mode jev` needs
`TYPESAFE_API_KEY`; `--mode both` is the default.
Benchmark JSON cannot provide executable commands. It can only select a command
from the reviewed catalog in src/benchmark.ts.

## Run history

Live Claude compactions and benchmark cases append versioned records to
`.jev/runs.jsonl`. The directory is ignored by Git. Records contain timestamps,
mode, status, controlled fallback reasons, metrics, and decision metadata only;
prompts, tool inputs, API keys, and raw tool output are never stored.

`readRuns()` returns newest records first, skips malformed JSONL lines, and
bounds reads to 1,000 records and the newest 4 MiB of the file.

## Local dashboard

Start the local dashboard from the repository root:

~~~powershell
npm.cmd run dashboard
npm.cmd run dashboard -- 4310
~~~

It binds only to `127.0.0.1`. The default port is `4310`.

Open `http://127.0.0.1:4310` to view the Kyu-inspired overview, Jev/local
comparison, trends, benchmark signals, filterable run history, and per-run
decision details. The interface supports light and dark themes and responsive
desktop, tablet, and mobile layouts.

- `GET /api/summary` returns overview cards, Jev/local comparisons, and trends.
- `GET /api/runs` returns bounded run summaries. Filters: `mode`, `status`,
  `from`, `to`, and `limit` (maximum 200).
- `GET /api/runs/:id` returns one safe record with decision metadata.

All endpoints read real records from `.jev/runs.jsonl`, return JSON only, apply
security headers, and never return prompts, tool inputs, API keys, or raw tool
output.

## Public cloud schema

The optional public portfolio stores sanitized metrics in Supabase while the
local JSONL file remains the primary record. Apply
`supabase/migrations/20260929160000_create_compaction_runs.sql` in the Supabase
SQL Editor. The migration enables RLS, grants no browser role direct access,
and stores no transcript, tool, path, or benchmark-identifying content. See
`supabase/README.md` for the manual steps.

Do not commit the Supabase service-role key, database password, or cloud
ingestion token. Cloud upload is disabled by default. After deploying the
Vercel endpoint, set these local values before running Claude Code or the
benchmark CLI:

~~~dotenv
JEV_CLOUD_UPLOAD=1
JEV_CLOUD_INGEST_URL=https://your-project.vercel.app/api/ingest
JEV_CLOUD_INGEST_TOKEN=your-ingestion-token
~~~

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the same
`JEV_CLOUD_INGEST_TOKEN` only in Vercel. The service-role key is never needed
locally. Each run is saved to `.jev/runs.jsonl` first; upload failures are
sanitized and never change compaction or benchmark results.

## Public Vercel dashboard

Import this repository into Vercel. The committed `vercel.json` selects the
framework-free `dashboard/` directory, runs the TypeScript build, and applies
security headers. Add these Environment Variables in Vercel for Production
(and Preview if you want preview deployments to use live data):

~~~dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JEV_CLOUD_INGEST_TOKEN=the-same-ingestion-token-used-locally
~~~

Deploy, then put the deployment URL into local `.env` as
`JEV_CLOUD_INGEST_URL=https://your-project.vercel.app/api/ingest`, enable
`JEV_CLOUD_UPLOAD=1`, reload those variables, and restart Claude Code.

The public site refreshes every 30 seconds while visible. `GET /api/summary`
and `GET /api/runs` read at most the newest 1,000 constrained Supabase rows;
run filters remain bounded to 200 results. Public responses omit exact run IDs,
fallback details, benchmark identifiers, decision details, and tool names.
`POST /api/ingest` remains protected by the ingestion token. The local
dashboard continues to provide private per-run details from `.jev/runs.jsonl`.

## Anonymous usage telemetry

The public dashboard's **community** totals (context saved, active installs,
compactions, average reduction) come from anonymous counts that the Claude Code
hook sends after each live compaction. Telemetry is **on by default**:

- **First compaction:** the hook creates a random install ID in the plugin's
  own store, prints a notice, and sends nothing.
- **Later compactions:** one small JSON event is sent to
  `https://jev-project-bay.vercel.app/api/telemetry`:

~~~json
{ "v": 1, "install_id": "<random 32 hex>", "plugin_version": "0.6.0",
  "mode": "local", "status": "applied",
  "tokens_before": 1000, "tokens_after": 600, "latency_ms": 13 }
~~~

That is the complete payload. Prompts, messages, code, file names, paths, tool
names, tool output, run IDs, and API keys are never sent. Benchmark runs are
never sent. The install ID is random and not derived from you or your machine.
The server does not store IP addresses; it keeps only a daily-rotating keyed
hash of the sender's address to rate-limit abuse. Sending is best-effort, times
out after 3 seconds, runs in parallel with other uploads, and never changes the
compaction result.

**Opt out** with any of:

- `JEV_TELEMETRY=0` in the environment
- `DO_NOT_TRACK=1` in the environment
- the plugin's `telemetry` option set to `false` (`/config`)

Once opted out, the hook does not create an install ID or send anything.
Self-hosters can point events elsewhere with `JEV_TELEMETRY_URL`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
