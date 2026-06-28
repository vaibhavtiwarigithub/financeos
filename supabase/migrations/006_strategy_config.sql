-- Strategy config for paper trading mode
CREATE TABLE IF NOT EXISTS strategy_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL DEFAULT 'paper',
  max_position_pct numeric NOT NULL DEFAULT 0.10,
  min_analyst_score integer NOT NULL DEFAULT 60,
  direction_filter text NOT NULL DEFAULT 'long',
  max_positions integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Insert default row if empty
INSERT INTO strategy_config (mode, max_position_pct, min_analyst_score, direction_filter, max_positions)
SELECT 'paper', 0.10, 60, 'long', 5
WHERE NOT EXISTS (SELECT 1 FROM strategy_config);

-- Allow all authenticated reads (internal tool only)
ALTER TABLE strategy_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_read_strategy_config" ON strategy_config
  FOR SELECT USING (true);
