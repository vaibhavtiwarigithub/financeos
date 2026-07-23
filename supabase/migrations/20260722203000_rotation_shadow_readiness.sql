-- Efficient, point-in-time return cohort for capital-rotation P0 diagnostics.
-- Read-only and service-role-only. It collapses provider revisions before rows
-- reach the application so the shadow path cannot silently truncate evidence.

create or replace function public.get_rotation_return_cohort(
  p_market text,
  p_symbols text[],
  p_since date
) returns table (
  symbol text,
  session_date date,
  simple_return numeric,
  available_at timestamptz
)
language sql stable security invoker set search_path to 'public'
as $function$
  select distinct on (r.symbol, r.session_date)
    r.symbol, r.session_date, r.simple_return, r.available_at
  from public.symbol_daily_returns r
  where p_market in ('us', 'india')
    and cardinality(p_symbols) between 1 and 20
    and r.market = p_market
    and r.symbol = any(p_symbols)
    and r.session_date >= p_since
  order by r.symbol, r.session_date, r.available_at desc;
$function$;

revoke all on function public.get_rotation_return_cohort(text,text[],date)
  from public, anon, authenticated;
grant execute on function public.get_rotation_return_cohort(text,text[],date)
  to service_role;
