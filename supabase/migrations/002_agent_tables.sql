-- Reconstructed from code — tables already exist in production. Safe to re-run (IF NOT EXISTS).

-- ============================================================
-- research_packets
-- Written by: app/api/agents/research/route.ts (INSERT)
-- Read by:    app/api/agents/paper-trade/route.ts (JOIN via agent_signals)
-- ============================================================
CREATE TABLE IF NOT EXISTS research_packets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol             TEXT        NOT NULL,
  fundamental_score  INTEGER,
  technical_score    INTEGER,
  sentiment_score    INTEGER,
  macro_score        INTEGER,
  insider_score      INTEGER,
  summary            TEXT,
  key_risks          JSONB,
  catalysts          JSONB,
  raw_data           JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE research_packets ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'research_packets' AND policyname = 'service_only'
  ) THEN
    CREATE POLICY service_only ON research_packets
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;

-- ============================================================
-- agent_signals
-- Written by: app/api/agents/research/route.ts (INSERT)
-- Read/updated by: app/api/agents/paper-trade/route.ts (SELECT + UPDATE status)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_signals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol               TEXT        NOT NULL,
  direction            TEXT        NOT NULL,  -- 'long' | 'neutral'
  analyst_score        INTEGER,
  conviction           INTEGER,
  agent_type           TEXT,                  -- 'research'
  research_packet_id   UUID        REFERENCES research_packets(id),
  status               TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'paper_traded'
  rationale            TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE agent_signals ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'agent_signals' AND policyname = 'service_only'
  ) THEN
    CREATE POLICY service_only ON agent_signals
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;

-- ============================================================
-- signal_weights
-- Read by: app/api/agents/research/route.ts (.select("*").single())
-- Phase 0: weight mutation disabled; row is read-only from code.
-- ============================================================
CREATE TABLE IF NOT EXISTS signal_weights (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fundamental_weight   NUMERIC NOT NULL DEFAULT 0.30,
  technical_weight     NUMERIC NOT NULL DEFAULT 0.25,
  sentiment_weight     NUMERIC NOT NULL DEFAULT 0.20,
  macro_weight         NUMERIC NOT NULL DEFAULT 0.15,
  insider_weight       NUMERIC NOT NULL DEFAULT 0.10,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE signal_weights ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'signal_weights' AND policyname = 'service_only'
  ) THEN
    CREATE POLICY service_only ON signal_weights
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;

-- Seed default weights row if table is empty
INSERT INTO signal_weights (fundamental_weight, technical_weight, sentiment_weight, macro_weight, insider_weight)
SELECT 0.30, 0.25, 0.20, 0.15, 0.10
WHERE NOT EXISTS (SELECT 1 FROM signal_weights LIMIT 1);

-- ============================================================
-- learning_log
-- Written by: app/api/agents/learner/route.ts (INSERT)
-- Read by:    components/dashboard/AgentsPage.tsx (l.id, l.note, l.created_at)
-- ============================================================
CREATE TABLE IF NOT EXISTS learning_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note               TEXT,
  weight_snapshot    JSONB,       -- null in Phase 0; reserved for Phase 1 weight diffs
  trades_evaluated   INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE learning_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'learning_log' AND policyname = 'service_only'
  ) THEN
    CREATE POLICY service_only ON learning_log
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;
