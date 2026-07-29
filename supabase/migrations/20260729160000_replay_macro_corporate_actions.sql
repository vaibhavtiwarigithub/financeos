-- Extend the existing sealed replay packet vocabulary for official macro vintages
-- and corporate actions. This is additive, measure-only, and read by no live path.

alter table public.replay_packet_items
  drop constraint if exists replay_packet_items_item_type_check;

alter table public.replay_packet_items
  add constraint replay_packet_items_item_type_check
  check (item_type in (
    'ohlcv', 'fundamental', 'news', 'universe', 'macro', 'corporate_action'
  ));

comment on column public.replay_packet_items.item_type is
  'Frozen replay evidence type. macro uses source realtime_start as knowable_at; '
  'corporate_action uses announcement timestamp or conservative ex-date fallback.';
