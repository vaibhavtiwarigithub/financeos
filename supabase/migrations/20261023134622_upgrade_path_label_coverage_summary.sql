-- Aggregate counts rather than returning an ever-growing raw label payload.
-- Only the server can read this summary; it grants no new client access.
create or replace function public.get_upgrade_path_label_coverage(p_market text)
returns table(horizon_days integer, observations bigint, distinct_dates bigint,
  distinct_symbols bigint, eligible_observations bigint, eligible_dates bigint, latest_session text)
language sql stable security invoker set search_path = '' as $$
  with source as (
    select l.horizon_days, (d.ts at time zone 'UTC')::date as session_date, d.symbol,
      d.entry_eligible is true and d.direction='long' and
      case when d.decision_context in ('entry_candidate','holding_review') then d.decision_context='entry_candidate'
        else d.discovery_source in ('watchlist','carry_forward','screener_momentum','screener_value',
          'metals_basket','crypto_basket','region_etf','india_screener','edge_relative_strength','manual') end as eligible
    from public.observation_labels l join public.decision_observations d on d.id=l.observation_id
    where p_market in ('us','india') and d.market=p_market
      and l.fwd_return is not null and l.matured_at<=now()
  )
  select horizon_days::integer, count(*), count(distinct session_date), count(distinct symbol),
    count(*) filter(where eligible), count(distinct session_date) filter(where eligible),
    max(session_date)::text
  from source group by horizon_days order by horizon_days;
$$;
revoke all on function public.get_upgrade_path_label_coverage(text) from public,anon,authenticated;
grant execute on function public.get_upgrade_path_label_coverage(text) to service_role;
