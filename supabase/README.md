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
ingestion token. The next cloud feature will read them from local and Vercel
environment variables.
