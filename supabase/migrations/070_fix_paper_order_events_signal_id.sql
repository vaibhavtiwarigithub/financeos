-- Long-standing schema bug fix: paper_order_events.signal_id was created as
-- bigint (migration 034), but agent_signals.id and paper_trades.signal_id are
-- BOTH uuid. Every paper fill's order-event insert (signal_id: signal.id, a
-- uuid string) has been failing on a type mismatch since day one — confirmed
-- live: paper_order_events has ZERO rows ever, despite paper_trades having
-- fills. This has been silently reverting every fill attempt's signal back to
-- 'pending' and skipping it. Table is empty, so the type change is lossless.

alter table paper_order_events alter column signal_id type uuid using signal_id::text::uuid;
