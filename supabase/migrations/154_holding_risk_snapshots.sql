-- Daily Per-Holding Risk Analytics — append-only snapshot ledger.
--
-- Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md.
--
-- Three additive, append-only tables:
--   holding_risk_runs      — one row per (market × account × trading-date × formula × input_hash)
--                            computation. Claimed via UNIQUE insert (run_key), never check-then-insert.
--   holding_risk_snapshots — one row per run × holding. Deterministic score/posture + LLM prose note.
--   account_risk_snapshots — one row per run. Persisted RiskMetrics roll-up for Δ-vs-prior trend.
--
-- Immutable: UPDATE/DELETE blocked by trigger. Reruns insert a NEW run; they never mutate a prior
-- snapshot. A failed run stays as evidence. No cross-currency roll-up: each row carries its own
-- market + currency and USD/INR are never summed. Owner-only SELECT, service_role writes, no anon.
-- Idempotent. Safe to re-run.

-- ── holding_risk_runs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.holding_risk_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key           text NOT NULL,                       -- market × account × trading-date × formula × input_hash
  market            text NOT NULL CHECK (market IN ('us','india')),
  currency          text NOT NULL CHECK (currency IN ('USD','INR')),
  broker            text NOT NULL,
  account_id        text NOT NULL,                       -- broker-verified identity (never a placeholder)
  account_label     text,
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed','partial')),
  captured_on       date NOT NULL,                       -- market-local completed session date
  source_captured_at timestamptz,                        -- as-of time of the account/quote snapshot
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  formula_version   text NOT NULL,
  input_hash        text,
  data_confidence   numeric CHECK (data_confidence IS NULL OR (data_confidence >= 0 AND data_confidence <= 1 AND data_confidence = data_confidence)),
  missing_inputs    text[] NOT NULL DEFAULT '{}',
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Run-level idempotency: concurrent/retried crons race on this unique insert; the loser reads back
-- the existing run instead of producing a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS holding_risk_runs_run_key_uniq
  ON public.holding_risk_runs (run_key);

-- Latest-complete lookups per market/account/currency/formula (read API).
CREATE INDEX IF NOT EXISTS holding_risk_runs_latest_idx
  ON public.holding_risk_runs (market, account_id, currency, formula_version, captured_on DESC)
  WHERE status = 'complete';

-- ── holding_risk_snapshots ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.holding_risk_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL REFERENCES public.holding_risk_runs(id),
  captured_on        date NOT NULL,
  market             text NOT NULL CHECK (market IN ('us','india')),
  currency           text NOT NULL CHECK (currency IN ('USD','INR')),
  broker             text NOT NULL,
  source             text,                               -- broker source name (robinhood|kite|...)
  source_captured_at timestamptz,
  account_id         text NOT NULL,
  account_label      text,
  symbol             text NOT NULL,
  sector             text,
  qty                numeric,
  current_price      numeric,
  average_cost       numeric,
  market_value       numeric CHECK (market_value IS NULL OR market_value >= 0),
  weight_pct         numeric CHECK (weight_pct IS NULL OR (weight_pct >= 0 AND weight_pct <= 1)),
  beta               numeric,
  realized_vol_pct   numeric,
  unrealized_pnl_pct numeric,
  holding_risk_score int CHECK (holding_risk_score IS NULL OR (holding_risk_score >= 0 AND holding_risk_score <= 100)),
  risk_label         text,
  risk_drivers       jsonb NOT NULL DEFAULT '{}'::jsonb, -- deterministic per-component detail
  risk_posture       text CHECK (risk_posture IS NULL OR risk_posture IN ('hold','review','trim','exit_review','insufficient_data')),
  action_reason      text,                               -- deterministic
  add_capacity       boolean NOT NULL DEFAULT false,     -- risk room exists; NEVER an order signal
  data_confidence    numeric CHECK (data_confidence IS NULL OR (data_confidence >= 0 AND data_confidence <= 1)),
  missing_inputs     text[] NOT NULL DEFAULT '{}',
  formula_version    text NOT NULL,
  strategy_note      text,                               -- LLM prose, nullable, best-effort, never blocks
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per run × holding. A rerun is a new run_id, so this never collides across days.
CREATE UNIQUE INDEX IF NOT EXISTS holding_risk_snapshots_run_symbol_uniq
  ON public.holding_risk_snapshots (run_id, symbol);

CREATE INDEX IF NOT EXISTS holding_risk_snapshots_run_idx
  ON public.holding_risk_snapshots (run_id);

CREATE INDEX IF NOT EXISTS holding_risk_snapshots_symbol_idx
  ON public.holding_risk_snapshots (account_id, symbol, captured_on DESC);

-- ── account_risk_snapshots ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.account_risk_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL REFERENCES public.holding_risk_runs(id),
  captured_on        date NOT NULL,
  market             text NOT NULL CHECK (market IN ('us','india')),
  currency           text NOT NULL CHECK (currency IN ('USD','INR')),
  broker             text NOT NULL,
  account_id         text NOT NULL,
  account_label      text,
  source_captured_at timestamptz,
  metrics            jsonb NOT NULL DEFAULT '{}'::jsonb, -- persisted RiskMetrics roll-up
  total_value        numeric CHECK (total_value IS NULL OR total_value >= 0),
  data_confidence    numeric CHECK (data_confidence IS NULL OR (data_confidence >= 0 AND data_confidence <= 1)),
  missing_inputs     text[] NOT NULL DEFAULT '{}',
  formula_version    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- One account roll-up row per run.
CREATE UNIQUE INDEX IF NOT EXISTS account_risk_snapshots_run_uniq
  ON public.account_risk_snapshots (run_id);

CREATE INDEX IF NOT EXISTS account_risk_snapshots_latest_idx
  ON public.account_risk_snapshots (market, account_id, currency, formula_version, captured_on DESC);

-- ── Immutability ──────────────────────────────────────────────────────────────
-- Two levels of immutability, matching the two roles these tables play:
--
--   holding_risk_snapshots / account_risk_snapshots are the RISK DATA LEDGERS — fully
--   append-only. UPDATE and DELETE are both blocked. A rerun inserts a new run_id; a prior
--   snapshot is never rewritten. This is the guarantee CLAUDE.md's append-only rule protects.
--
--   holding_risk_runs is a CLAIM / LIFECYCLE record (like broker_orders): inserted once at
--   claim time as 'running', then transitioned exactly once to a terminal status
--   (complete|failed|partial) by the publish RPC. DELETE is always blocked. The claim's
--   IDENTITY and any captured evidence columns are frozen — only the lifecycle columns
--   (status, completed_at, error, data_confidence, missing_inputs, input_hash,
--   source_captured_at) may change, and only forward out of 'running'. This makes the run
--   un-hijackable and un-rewritable while allowing the running→terminal transition the
--   publish step legitimately needs.

CREATE OR REPLACE FUNCTION public.holding_risk_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only — updates and deletes are not allowed', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION public.holding_risk_runs_lifecycle_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holding_risk_runs rows cannot be deleted';
  END IF;
  -- Identity / captured-evidence columns are frozen once claimed.
  IF NEW.id            IS DISTINCT FROM OLD.id
  OR NEW.run_key       IS DISTINCT FROM OLD.run_key
  OR NEW.market        IS DISTINCT FROM OLD.market
  OR NEW.currency      IS DISTINCT FROM OLD.currency
  OR NEW.broker        IS DISTINCT FROM OLD.broker
  OR NEW.account_id    IS DISTINCT FROM OLD.account_id
  OR NEW.account_label IS DISTINCT FROM OLD.account_label
  OR NEW.captured_on   IS DISTINCT FROM OLD.captured_on
  OR NEW.started_at    IS DISTINCT FROM OLD.started_at
  OR NEW.formula_version IS DISTINCT FROM OLD.formula_version
  OR NEW.created_at    IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'holding_risk_runs identity columns are immutable';
  END IF;
  -- Status may only move forward out of 'running' (never back, never terminal→terminal).
  IF OLD.status IS DISTINCT FROM NEW.status AND OLD.status <> 'running' THEN
    RAISE EXCEPTION 'holding_risk_runs.status is terminal (%); cannot transition to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS holding_risk_runs_lifecycle ON public.holding_risk_runs;
CREATE TRIGGER holding_risk_runs_lifecycle
  BEFORE UPDATE OR DELETE ON public.holding_risk_runs
  FOR EACH ROW EXECUTE FUNCTION public.holding_risk_runs_lifecycle_guard();

DROP TRIGGER IF EXISTS holding_risk_snapshots_immutable ON public.holding_risk_snapshots;
CREATE TRIGGER holding_risk_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.holding_risk_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.holding_risk_append_only();

DROP TRIGGER IF EXISTS account_risk_snapshots_immutable ON public.account_risk_snapshots;
CREATE TRIGGER account_risk_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.account_risk_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.holding_risk_append_only();

-- ── RLS: service_role writes, owner-email SELECT, no anon ──────────────────────
ALTER TABLE public.holding_risk_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holding_risk_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_risk_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='holding_risk_runs' AND policyname='hrr_service_all') THEN
    CREATE POLICY hrr_service_all ON public.holding_risk_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='holding_risk_runs' AND policyname='hrr_owner_read') THEN
    CREATE POLICY hrr_owner_read ON public.holding_risk_runs FOR SELECT TO authenticated
      USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='holding_risk_snapshots' AND policyname='hrs_service_all') THEN
    CREATE POLICY hrs_service_all ON public.holding_risk_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='holding_risk_snapshots' AND policyname='hrs_owner_read') THEN
    CREATE POLICY hrs_owner_read ON public.holding_risk_snapshots FOR SELECT TO authenticated
      USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='account_risk_snapshots' AND policyname='ars_service_all') THEN
    CREATE POLICY ars_service_all ON public.account_risk_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='account_risk_snapshots' AND policyname='ars_owner_read') THEN
    CREATE POLICY ars_owner_read ON public.account_risk_snapshots FOR SELECT TO authenticated
      USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
  END IF;
END $$;

REVOKE ALL ON public.holding_risk_runs      FROM anon;
REVOKE ALL ON public.holding_risk_snapshots FROM anon;
REVOKE ALL ON public.account_risk_snapshots FROM anon;
