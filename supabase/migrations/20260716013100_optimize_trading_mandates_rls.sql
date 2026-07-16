-- Advisor cleanup for the mandate table touched by the capacity migration.

create index if not exists trading_mandates_updated_by_idx
  on public.trading_mandates(updated_by)
  where updated_by is not null;

drop policy if exists trading_mandates_owner_read on public.trading_mandates;
create policy trading_mandates_owner_read
  on public.trading_mandates
  for select
  to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
