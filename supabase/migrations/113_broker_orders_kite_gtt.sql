-- Server-side stop/target: track Kite GTT trigger IDs on live India buy orders.
-- A GTT (Good Till Triggered) two-leg bracket is placed at Kite after a live BUY
-- so stop-loss and take-profit fire even if Kairos is offline during market hours.
-- Cancelled when the position is manually sold through the Kite order route.
alter table broker_orders add column if not exists kite_gtt_id text;
comment on column broker_orders.kite_gtt_id is
  'Zerodha GTT trigger_id placed as server-side bracket (stop+target) after a live India BUY. Null for US orders or India orders where GTT placement was skipped/failed.';
