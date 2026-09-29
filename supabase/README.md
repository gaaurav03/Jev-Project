# Supabase schema

The cloud dashboard stores only sanitized compaction metrics in
`public.compaction_runs`. It does not store prompts, transcript messages, tool
names, tool inputs, raw tool output, private paths, or benchmark case names.

## Apply the migration

1. Open the Supabase project dashboard.
2. Open **SQL Editor** and create a new query.
3. Paste the complete contents of
   `migrations/20260929160000_create_compaction_runs.sql`.
4. Run the query once.
5. In **Table Editor**, confirm `compaction_runs` exists and RLS is enabled.

The table intentionally has no anonymous or authenticated policies. Only the
server-side `service_role` used by Vercel may read or insert rows. The public
browser will receive a smaller, sanitized response from Vercel API functions;
it will never connect directly to this table.

Never commit the database password, service-role key, project keys, or cloud
ingestion token. Vercel needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`JEV_CLOUD_INGEST_TOKEN`. Local Claude Code and benchmark runs need only
`JEV_CLOUD_UPLOAD=1`, `JEV_CLOUD_INGEST_URL`, and the matching ingestion token.
The browser never receives either secret.

## Community telemetry

Run `migrations/20260930120000_create_telemetry_events.sql` once in the SQL
Editor, the same way. It creates `public.telemetry_events` (anonymous install
ID, mode, status, token estimates, and a daily-rotating source hash for rate
limiting; no IP addresses) and two functions:

- `record_telemetry(...)` inserts one event unless that install sent 120 or
  that source sent 600 in the last hour.
- `community_stats()` returns the public totals and a 30-day daily series.

RLS is enabled and the table and both functions are revoked from `public`,
`anon`, and `authenticated`; only `service_role` (Vercel) can call them. No new
Vercel variables are needed.

## Connect Vercel

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`JEV_CLOUD_INGEST_TOKEN` in the Vercel project settings, then deploy the
repository. Do not add `SUPABASE_SERVICE_ROLE_KEY` to local `.env`; Claude Code
needs only the ingestion URL and token. The browser calls Vercel functions and
never receives Supabase credentials or direct table access.
