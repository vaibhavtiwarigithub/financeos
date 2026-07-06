-- Part A1/A2 (Decision 38): profile-scaled kill-switch thresholds + exit hysteresis.
-- Applied live via Supabase MCP on 2026-07-06; this file was missing until the
-- ultra-review flagged that none of tonight's schema changes had a committed
-- migration (they only existed in the live DB).
alter table strategy_config
  add column if not exists ks_daily_loss_pct numeric,
  add column if not exists ks_drawdown_pct numeric,
  add column if not exists ks_accuracy_pct numeric,
  add column if not exists exit_hysteresis numeric;
