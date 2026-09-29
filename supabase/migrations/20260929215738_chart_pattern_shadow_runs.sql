-- Measure-only, per-decision pattern attempts. Outcomes remain in
-- observation_labels so this immutable decision-time ledger never receives future data.
create table if not exists public.chart_pattern_shadow_runs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  market text not null check (market in ('us','india')),
  symbol text not null,
  decision_observation_id bigint not null references public.decision_observations(id) on delete restrict,
  detection_status text not null check (detection_status in ('detected','no_pattern','insufficient_candles')),
  pattern_type text check (pattern_type in ('double_top','double_bottom')),
  swing1_date date,
  swing1_close numeric,
  swing2_date date,
  swing2_close numeric,
  neckline_date date,
  neckline_close numeric,
  confirmation_date date,
  confirmation_close numeric,
  candles_through_date date,
  candle_source text not null,
  detector_version text not null,
  detector_config jsonb not null,
  constraint chart_pattern_shadow_shape check (
    (detection_status = 'detected' and pattern_type is not null and swing1_date is not null
      and swing1_close > 0 and swing2_date > swing1_date and swing2_close > 0
      and neckline_date > swing1_date and neckline_date < swing2_date
      and neckline_close > 0 and confirmation_date >= swing2_date and confirmation_close > 0)
    or
    (detection_status <> 'detected' and pattern_type is null and swing1_date is null
      and swing1_close is null and swing2_date is null and swing2_close is null
      and neckline_date is null and neckline_close is null and confirmation_date is null
      and confirmation_close is null)
  ),
  constraint chart_pattern_shadow_one_attempt_per_observation unique (decision_observation_id)
);

create index if not exists chart_pattern_shadow_market_created_idx
  on public.chart_pattern_shadow_runs (market, created_at desc);
create index if not exists chart_pattern_shadow_market_pattern_idx
  on public.chart_pattern_shadow_runs (market, pattern_type, confirmation_date desc)
  where detection_status = 'detected';

alter table public.chart_pattern_shadow_runs enable row level security;
drop policy if exists chart_pattern_shadow_runs_owner_read on public.chart_pattern_shadow_runs;
create policy chart_pattern_shadow_runs_owner_read on public.chart_pattern_shadow_runs
  for select to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
revoke all on public.chart_pattern_shadow_runs from anon, authenticated;
grant select on public.chart_pattern_shadow_runs to authenticated;
revoke update, delete, truncate on public.chart_pattern_shadow_runs from service_role;
grant select, insert on public.chart_pattern_shadow_runs to service_role;
grant usage, select on sequence public.chart_pattern_shadow_runs_id_seq to service_role;

create or replace function public.prevent_chart_pattern_shadow_mutation()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  raise exception 'chart_pattern_shadow_runs is append-only';
end;
$$;

drop trigger if exists chart_pattern_shadow_runs_immutable on public.chart_pattern_shadow_runs;
create trigger chart_pattern_shadow_runs_immutable
  before update or delete on public.chart_pattern_shadow_runs
  for each row execute function public.prevent_chart_pattern_shadow_mutation();
drop trigger if exists chart_pattern_shadow_runs_no_truncate on public.chart_pattern_shadow_runs;
create trigger chart_pattern_shadow_runs_no_truncate
  before truncate on public.chart_pattern_shadow_runs
  for each statement execute function public.prevent_chart_pattern_shadow_mutation();
