alter table paper_positions
  add column if not exists price_target numeric(12,2),
  add column if not exists stop_loss numeric(12,2),
  add column if not exists highest_price numeric(12,2),
  add column if not exists target_updated_at timestamptz,
  add column if not exists exit_reason text;
