alter table strategy_config
  add column if not exists risk_profile text default 'balanced',
  add column if not exists score_threshold int default 60,
  add column if not exists position_size_pct numeric(5,2) default 10.0,
  add column if not exists stop_loss_pct numeric(5,2) default 7.0,
  add column if not exists target_pct numeric(5,2) default 20.0;
