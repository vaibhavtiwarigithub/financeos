-- Per-symbol macro exposure estimates for India (rolling OLS betas to market, USD/INR, Brent, India VIX).
-- Measure-only: nothing in scoring reads it. Append-only, keyed by the last return session used, so each
-- estimate is reproducible and history is point-in-time.

create table if not exists public.india_macro_exposures (
  id bigint generated always as identity primary key,
  symbol text not null,
  window_start date,
  window_end date not null,
  n_obs int not null,
  factor_coverage numeric not null,
  status text not null check (status in ('ok', 'insufficient_observations', 'insufficient_factor_coverage', 'singular')),
  r2 numeric,
  betas jsonb,
  tstats jsonb,
  significant text[],
  computed_at timestamptz not null default now(),
  run_id text not null,
  unique (symbol, window_end)
);

create index if not exists india_macro_exposures_symbol_idx on public.india_macro_exposures (symbol, window_end desc);

alter table public.india_macro_exposures enable row level security;
revoke all on public.india_macro_exposures from anon, authenticated;

create or replace function public.india_macro_exposures_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'india_macro_exposures is append-only';
end $$;

drop trigger if exists india_macro_exposures_no_change on public.india_macro_exposures;
create trigger india_macro_exposures_no_change
  before update or delete on public.india_macro_exposures
  for each row execute function public.india_macro_exposures_append_only();

-- Weekly, Sunday 14:00 UTC (19:30 IST): after the Friday session's returns and macro series are in.
select cron.schedule(
  'kairos-india-macro-exposure',
  '0 14 * * 0',
  $$select public.kairos_call_agent('/api/agents/india-macro-exposure', '{}'::jsonb, 'POST', 60000)$$
);
