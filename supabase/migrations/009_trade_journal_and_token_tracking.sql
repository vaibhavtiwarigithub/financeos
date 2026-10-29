-- Trade Journal: link per-trade learning notes to specific trades
ALTER TABLE learning_log ADD COLUMN IF NOT EXISTS trade_id UUID REFERENCES paper_trades(id);
CREATE INDEX IF NOT EXISTS idx_learning_log_trade_id ON learning_log(trade_id) WHERE trade_id IS NOT NULL;

-- Token tracking: record Claude CLI usage per agent run
-- The production table predates this repository's migration chain. Keep the
-- clean replay self-contained while leaving already-provisioned databases
-- unchanged: the table definition matches the original agent_runs baseline.
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  symbols TEXT[],
  result_summary TEXT,
  signals_written INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tokens_input INTEGER;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tokens_output INTEGER;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS claude_calls INTEGER DEFAULT 0;

-- The production trade journal was originally created outside the tracked
-- migration chain. Recreate its exact base contract for clean installs before
-- migration 030 adds mentor dimensions; an existing production table is left
-- intact by IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS public.trade_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  symbol TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'watching')),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('post_trade', 'pre_trade_thesis')),
  user_reasoning TEXT NOT NULL,
  ai_evaluation TEXT,
  ai_score INTEGER CHECK (ai_score BETWEEN 0 AND 100),
  verdict TEXT CHECK (verdict IN ('sound', 'flawed', 'mixed', 'emotional', 'strong')),
  bias_flags TEXT[] DEFAULT '{}',
  suggestions TEXT,
  data_verified JSONB DEFAULT '{}'::jsonb,
  paper_trade_id UUID,
  outcome_score INTEGER CHECK (outcome_score BETWEEN 0 AND 100),
  outcome_updated_at TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ
);

ALTER TABLE public.trade_journal ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'trade_journal'
      AND policyname = 'Users see own journal'
  ) THEN
    CREATE POLICY "Users see own journal" ON public.trade_journal
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS trade_journal_user_created
  ON public.trade_journal (user_id, created_at DESC);

-- Performance indexes for journal queries
CREATE INDEX IF NOT EXISTS idx_paper_trades_signal_id ON paper_trades(signal_id) WHERE signal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_signals_packet_id ON agent_signals(research_packet_id) WHERE research_packet_id IS NOT NULL;
