-- Dated, append-only India macro series (rates, FX, oil, volatility, institutional flows). Measure-only
-- groundwork: nothing in scoring reads it. First-seen value per (series, source, obs_date) is kept so the
-- history is point-in-time; fetched_at records when it became knowable.

create table if not exists public.india_macro_observations (
  id bigint generated always as identity primary key,
  series_id text not null,
  source text not null check (source in ('fred', 'yahoo', 'nse')),
  obs_date date not null,
  value numeric not null,
  fetched_at timestamptz not null default now(),
  run_id text not null,
  unique (series_id, source, obs_date)
);

create index if not exists india_macro_observations_series_date_idx
  on public.india_macro_observations (series_id, obs_date desc);

alter table public.india_macro_observations enable row level security;
revoke all on public.india_macro_observations from anon, authenticated;

create or replace function public.india_macro_observations_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'india_macro_observations is append-only';
end $$;

drop trigger if exists india_macro_observations_no_change on public.india_macro_observations;
create trigger india_macro_observations_no_change
  before update or delete on public.india_macro_observations
  for each row execute function public.india_macro_observations_append_only();

-- 13:00 UTC = 18:30 IST: after the NSE close and the provisional FII/DII publication.
select cron.schedule(
  'kairos-india-macro-series',
  '0 13 * * *',
  $$select public.kairos_call_agent('/api/agents/india-macro-series', '{}'::jsonb, 'POST', 60000)$$
);
