-- Ops spec Part 2 (Decision 39): per-market active broker for the Execution
-- Gateway's adapter registry.
alter table strategy_config
  add column if not exists active_broker_us text default 'alpaca',
  add column if not exists active_broker_india text default 'kite';
