-- A provider budget is a hard reservation, not a telemetry counter.  The old
-- increment RPC continued increasing after a caller had already been denied,
-- making the Settings panel claim 40-90 Alpha Vantage "calls" on a 25-call
-- key.  This function atomically grants at most p_limit slots per UTC day.
create or replace function public.provider_budget_reserve(
  p_provider text,
  p_date date,
  p_limit integer
)
returns table(granted boolean, calls integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  reserved_calls integer;
  observed_calls integer;
begin
  if p_limit < 1 then
    select b.calls into observed_calls
    from public.provider_budget b
    where b.provider = p_provider and b.cache_date = p_date;
    return query select false, coalesce(observed_calls, 0);
    return;
  end if;

  insert into public.provider_budget(provider, cache_date, calls)
  values (p_provider, p_date, 1)
  on conflict (provider, cache_date) do update
    set calls = public.provider_budget.calls + 1
    where public.provider_budget.calls < p_limit
  returning public.provider_budget.calls into reserved_calls;

  if found then
    return query select true, reserved_calls;
    return;
  end if;

  select b.calls into observed_calls
  from public.provider_budget b
  where b.provider = p_provider and b.cache_date = p_date;
  return query select false, coalesce(observed_calls, 0);
end;
$$;

revoke all on function public.provider_budget_reserve(text, date, integer) from public, anon, authenticated;
grant execute on function public.provider_budget_reserve(text, date, integer) to service_role;
