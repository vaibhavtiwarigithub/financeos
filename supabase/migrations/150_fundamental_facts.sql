-- Point-in-Time (PIT) fundamentals archive.
-- Append-only vintage ledger: one immutable row per (symbol, market, report_period,
-- restatement vintage). A later restatement of the SAME report_period inserts a NEW row
-- with restatement_seq = prev+1 and flips the prior row's is_latest=false — nothing is
-- ever mutated in place, so "fundamentals as known on date D" is reconstructable and a
-- restatement can never retroactively change a past as-of read.
--
-- OFF by default: written by the capture-on-fetch hook in lib/research-agent.ts; read via
-- lib/data/pit-fundamentals.ts:getFundamentalsAsOf. Not yet wired into live scoring —
-- scoreFundamentals is unchanged and default scores are byte-identical.
--
-- Spec: features/pit-fundamentals/FEATURE_ARCHITECTURE.md.
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.fundamental_facts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          text NOT NULL,
  market          text NOT NULL DEFAULT 'us' CHECK (market IN ('us','india')),
  metric_set      text NOT NULL DEFAULT 'ttm_overview',
  report_period   date,                       -- fiscal period end the values describe (null for TTM rollups)
  fiscal_period   text,                        -- Q1/Q2/Q3/Q4/FY (nullable)
  filing_date     date,                        -- when it became public (nullable → fall back to captured_at)
  values          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- OVERVIEW-shaped field map (PERatio, ProfitMargin, ...)
  source          text,                        -- fmp | alpha_vantage | yahoo | financialdatasets
  restatement_seq int  NOT NULL DEFAULT 0,     -- 0 = as-first-observed; 1,2,... = later restatements
  is_latest       boolean NOT NULL DEFAULT true,
  payload_hash    text NOT NULL,               -- dedup key for identical re-fetches
  captured_at     timestamptz NOT NULL DEFAULT now()  -- Kairos vintage clock
);

-- Dedup identical re-fetches: the same payload can only be stored once.
CREATE UNIQUE INDEX IF NOT EXISTS fundamental_facts_payload_uniq
  ON public.fundamental_facts (payload_hash);

-- As-of reads scan a single symbol's vintages ordered by the known-clock.
CREATE INDEX IF NOT EXISTS fundamental_facts_symbol_known_idx
  ON public.fundamental_facts (symbol, market, COALESCE(filing_date, captured_at::date) DESC);

-- Restatement grouping / latest-vintage lookups.
CREATE INDEX IF NOT EXISTS fundamental_facts_period_idx
  ON public.fundamental_facts (symbol, market, report_period, restatement_seq);

CREATE INDEX IF NOT EXISTS fundamental_facts_latest_idx
  ON public.fundamental_facts (symbol, market) WHERE is_latest;

ALTER TABLE public.fundamental_facts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fundamental_facts' AND policyname='ff_service_all') THEN
    CREATE POLICY ff_service_all ON public.fundamental_facts FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fundamental_facts' AND policyname='ff_owner_read') THEN
    CREATE POLICY ff_owner_read ON public.fundamental_facts FOR SELECT TO authenticated
      USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
  END IF;
END $$;
REVOKE ALL ON public.fundamental_facts FROM anon;
