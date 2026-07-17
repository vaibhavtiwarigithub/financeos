-- Option A: persist the frozen per-session return series required for future
-- candidate-to-book correlation. Measure-only; no trading path reads this table.

create table if not exists public.symbol_daily_returns (
  id                    bigserial primary key,
  symbol                text not null,
  market                text not null check (market in ('us','india')),
  session_date          date not null,
  previous_session_date date not null,
  available_at          timestamptz not null,
  source                text not null,
  price_basis           text not null check (price_basis in ('adjusted_close','raw_close')),
  close                 numeric not null check (close > 0),
  previous_close        numeric not null check (previous_close > 0),
  simple_return         numeric not null check (simple_return > -1),
  input_fingerprint     text not null,
  created_at            timestamptz not null default now(),
  constraint symbol_daily_returns_dates_ck check (previous_session_date < session_date),
  constraint symbol_daily_returns_pit_ck check (session_date <= (available_at at time zone 'utc')::date),
  unique (symbol, market, session_date, source, price_basis, input_fingerprint)
);

create index if not exists symbol_daily_returns_alignment_idx
  on public.symbol_daily_returns (market, symbol, session_date, available_at desc);

create or replace function public.symbol_daily_returns_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'symbol_daily_returns is append-only (evidence)';
end;
$$;

drop trigger if exists symbol_daily_returns_no_update on public.symbol_daily_returns;
create trigger symbol_daily_returns_no_update
  before update or delete on public.symbol_daily_returns
  for each row execute function public.symbol_daily_returns_immutable();

alter table public.symbol_daily_returns enable row level security;
drop policy if exists symbol_daily_returns_owner_read on public.symbol_daily_returns;
create policy symbol_daily_returns_owner_read
  on public.symbol_daily_returns for select to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

revoke all on table public.symbol_daily_returns from anon, authenticated;
grant select on table public.symbol_daily_returns to authenticated;
grant usage, select on sequence public.symbol_daily_returns_id_seq to service_role;

-- Tighten the summary table's initial authenticated-wide read policy. Kairos is
-- single-owner; another authenticated account must not see portfolio research.
drop policy if exists symbol_return_observations_authenticated_read on public.symbol_return_observations;
drop policy if exists symbol_return_observations_owner_read on public.symbol_return_observations;
create policy symbol_return_observations_owner_read
  on public.symbol_return_observations for select to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
revoke all on table public.symbol_return_observations from anon, authenticated;
grant select on table public.symbol_return_observations to authenticated;
