-- Corrective, unapplied migration for the protective-order shadow schema.
-- This changes no enable flags and places no broker order.

alter table public.protective_orders
  drop constraint if exists protective_orders_mode_check,
  add constraint protective_orders_mode_check check (mode = 'wider_disaster_floor'),
  alter column currency set not null,
  add constraint protective_orders_market_currency_check check (
    (market = 'us' and currency = 'USD') or
    (market = 'india' and currency = 'INR')
  ),
  add constraint protective_orders_single_broker_id_check check (
    num_nonnulls(broker_order_id, kite_trigger_id) <= 1 and
    (status not in ('active','triggered','filled','canceling','canceled') or
      num_nonnulls(broker_order_id, kite_trigger_id) = 1)
  ),
  add constraint protective_orders_floor_is_wider_check check (broker_floor < analytical_stop),
  add constraint protective_orders_kind_price_check check (
    (order_kind = 'stop_market' and limit_price is null) or
    (order_kind in ('stop_limit','gtt_limit') and limit_price is not null)
  ),
  add constraint protective_orders_learning_provenance_check check (
    (exit_reason is null and learning_scope = 'full') or
    (exit_reason = 'protective_disaster_floor' and learning_scope = 'risk_policy_only')
  );

revoke all on sequence public.protective_orders_id_seq from anon, authenticated;
revoke all on sequence public.protective_order_events_id_seq from anon, authenticated;
grant usage, select on sequence public.protective_orders_id_seq to service_role;
grant usage, select on sequence public.protective_order_events_id_seq to service_role;

revoke execute on function public.protective_orders_touch_updated_at() from public, anon, authenticated;
revoke execute on function public.protective_order_events_immutable() from public, anon, authenticated;
grant execute on function public.protective_orders_touch_updated_at() to service_role;
grant execute on function public.protective_order_events_immutable() to service_role;
