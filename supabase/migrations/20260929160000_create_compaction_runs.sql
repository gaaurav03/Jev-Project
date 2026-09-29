create table public.compaction_runs (
  id text primary key check (id ~ '^run-[a-z0-9-]{8,80}$'),
  record_version smallint not null default 1 check (record_version = 1),
  run_at timestamptz not null,
  source text not null check (source in ('live', 'benchmark')),
  mode text not null check (mode in ('jev', 'local')),
  status text not null check (status in ('applied', 'fallback', 'passed', 'failed')),
  fallback_reason text check (
    fallback_reason in (
      'below_minimum_reduction',
      'missing_api_key',
      'request_timeout',
      'remote_error',
      'compaction_error'
    )
  ),
  estimated_tokens_before bigint check (estimated_tokens_before >= 0),
  estimated_tokens_after bigint check (estimated_tokens_after >= 0),
  estimated_tokens_saved bigint check (estimated_tokens_saved >= 0),
  estimated_reduction double precision check (
    estimated_reduction >= 0 and estimated_reduction <= 1
  ),
  latency_ms double precision check (latency_ms >= 0),
  request_count integer check (request_count >= 0),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  known_cost_usd numeric(18, 8) check (known_cost_usd >= 0),
  critical_required integer check (critical_required >= 0),
  critical_retained integer check (
    critical_retained >= 0 and critical_retained <= critical_required
  ),
  task_passed boolean,
  kept_count integer not null default 0 check (kept_count >= 0),
  truncated_count integer not null default 0 check (truncated_count >= 0),
  removed_count integer not null default 0 check (removed_count >= 0),
  received_at timestamptz not null default now(),
  constraint compaction_runs_source_status check (
    (source = 'live' and status in ('applied', 'fallback')) or
    (source = 'benchmark' and status in ('passed', 'failed'))
  ),
  constraint compaction_runs_fallback check (
    (status = 'fallback') = (fallback_reason is not null)
  ),
  constraint compaction_runs_metrics_complete check (
    (
      estimated_tokens_before is null and
      estimated_tokens_after is null and
      estimated_tokens_saved is null and
      estimated_reduction is null and
      latency_ms is null and
      request_count is null
    ) or (
      estimated_tokens_before is not null and
      estimated_tokens_after is not null and
      estimated_tokens_saved is not null and
      estimated_reduction is not null and
      latency_ms is not null and
      request_count is not null and
      estimated_tokens_after <= estimated_tokens_before and
      estimated_tokens_saved = estimated_tokens_before - estimated_tokens_after
    )
  ),
  constraint compaction_runs_status_metrics check (
    status = 'fallback' or estimated_tokens_before is not null
  ),
  constraint compaction_runs_usage check (
    estimated_tokens_before is not null or
    (input_tokens is null and output_tokens is null and known_cost_usd is null)
  ),
  constraint compaction_runs_benchmark check (
    (
      source = 'live' and
      critical_required is null and
      critical_retained is null and
      task_passed is null
    ) or (
      source = 'benchmark' and
      critical_required is not null and
      critical_retained is not null and
      task_passed is not null and
      ((status = 'passed') = task_passed)
    )
  )
);

create index compaction_runs_run_at_idx
  on public.compaction_runs (run_at desc);

alter table public.compaction_runs enable row level security;

revoke all on table public.compaction_runs from anon, authenticated;
grant select, insert on table public.compaction_runs to service_role;

comment on table public.compaction_runs is
  'Sanitized compaction metrics for the public portfolio dashboard; no transcript or tool content.';
