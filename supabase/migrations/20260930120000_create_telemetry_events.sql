-- Anonymous, opt-out community telemetry. One row per live compaction: an
-- anonymous install ID, mode, status, and token estimates. No transcript, tool,
-- path, or network identity is stored; source_hash is a daily-rotating HMAC
-- used only for rate limiting.
create table public.telemetry_events (
  id bigint generated always as identity primary key,
  install_id text not null check (install_id ~ '^[0-9a-f]{32}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  plugin_version text not null check (plugin_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  mode text not null check (mode in ('jev', 'local')),
  status text not null check (status in ('applied', 'fallback')),
  tokens_before bigint check (tokens_before >= 0 and tokens_before <= 5000000),
  tokens_after bigint check (tokens_after >= 0 and tokens_after <= tokens_before),
  latency_ms integer check (latency_ms >= 0 and latency_ms <= 600000),
  constraint telemetry_events_metrics_complete check (
    (tokens_before is null and tokens_after is null and latency_ms is null) or
    (tokens_before is not null and tokens_after is not null and latency_ms is not null)
  ),
  constraint telemetry_events_applied_metrics check (
    status = 'fallback' or tokens_before is not null
  )
);

create index telemetry_events_received_at_idx
  on public.telemetry_events (received_at desc);
create index telemetry_events_install_idx
  on public.telemetry_events (install_id, received_at desc);
create index telemetry_events_source_idx
  on public.telemetry_events (source_hash, received_at desc);

alter table public.telemetry_events enable row level security;

revoke all on table public.telemetry_events from anon, authenticated;
grant select, insert on table public.telemetry_events to service_role;

comment on table public.telemetry_events is
  'Anonymous community compaction counts; no transcript, tool, path, or IP data.';

-- Inserts one event unless its install or source exceeded the hourly limit.
create function public.record_telemetry(
  p_install_id text,
  p_source_hash text,
  p_plugin_version text,
  p_mode text,
  p_status text,
  p_tokens_before bigint,
  p_tokens_after bigint,
  p_latency_ms integer
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (
    select count(*) from public.telemetry_events
    where install_id = p_install_id and received_at > now() - interval '1 hour'
  ) >= 120 or (
    select count(*) from public.telemetry_events
    where source_hash = p_source_hash and received_at > now() - interval '1 hour'
  ) >= 600 then
    return 'rate_limited';
  end if;

  insert into public.telemetry_events (
    install_id, source_hash, plugin_version, mode, status,
    tokens_before, tokens_after, latency_ms
  ) values (
    p_install_id, p_source_hash, p_plugin_version, p_mode, p_status,
    p_tokens_before, p_tokens_after, p_latency_ms
  );
  return 'accepted';
end;
$$;

-- Public aggregate totals; only applied compactions count as saved context.
create function public.community_stats()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with applied as (
    select * from public.telemetry_events where status = 'applied'
  ),
  days as (
    select generate_series(
      ((now() at time zone 'utc')::date - 29)::timestamp,
      (now() at time zone 'utc')::date::timestamp,
      interval '1 day'
    )::date as day
  )
  select jsonb_build_object(
    'installs', (select count(distinct install_id) from public.telemetry_events),
    'activeInstalls7d', (
      select count(distinct install_id) from public.telemetry_events
      where received_at > now() - interval '7 days'
    ),
    'activeInstalls30d', (
      select count(distinct install_id) from public.telemetry_events
      where received_at > now() - interval '30 days'
    ),
    'runs', (select count(*) from public.telemetry_events),
    'compactions', (select count(*) from applied),
    'tokensBefore', (select coalesce(sum(tokens_before), 0) from applied),
    'tokensSaved', (select coalesce(sum(tokens_before - tokens_after), 0) from applied),
    'averageReduction', (
      select avg((tokens_before - tokens_after)::double precision / tokens_before)
      from applied where tokens_before > 0
    ),
    'modes', jsonb_build_object(
      'jev', (select count(*) from applied where mode = 'jev'),
      'local', (select count(*) from applied where mode = 'local')
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', to_char(d.day, 'YYYY-MM-DD'),
        'compactions', coalesce(t.compactions, 0),
        'tokensSaved', coalesce(t.tokens_saved, 0),
        'activeInstalls', coalesce(t.active_installs, 0)
      ) order by d.day), '[]'::jsonb)
      from days d
      left join (
        select
          (received_at at time zone 'utc')::date as day,
          count(*) filter (where status = 'applied') as compactions,
          coalesce(sum(tokens_before - tokens_after) filter (where status = 'applied'), 0) as tokens_saved,
          count(distinct install_id) as active_installs
        from public.telemetry_events
        where received_at > now() - interval '31 days'
        group by 1
      ) t on t.day = d.day
    )
  );
$$;

revoke all on function public.record_telemetry(text, text, text, text, text, bigint, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.community_stats() from public, anon, authenticated;
grant execute on function public.record_telemetry(text, text, text, text, text, bigint, bigint, integer)
  to service_role;
grant execute on function public.community_stats() to service_role;
