-- W4 + W5 — mark provenance for paper NAV, and session provenance for benchmarks.
--
-- W4. `paper_positions.current_price` is mutated in place and
-- `paper_nav_history` stores aggregates only, so once a run overwrites a mark
-- the previous one is gone. On 2026-08-12 the US paper NAV moved +2.70% and
-- then -2.97% while the nine held positions actually moved -0.48%; the round
-- trip was not market P&L and it can never be attributed, because the
-- provenance needed to explain it was never written. `paper_position_marks` is
-- the append-only record that makes the NEXT such move explicable: one row per
-- position per run, carrying the qty, the mark, the provider, the provider's
-- own observation time, whether the mark was stale, and why.
--
-- W5. `paper_performance.bench_nav` carried no session identity. VOO's
-- 2026-08-11 close (708.42) is stored under both 2026-08-12 and 2026-08-13
-- because the writer accepted any positive quote and labelled it with the cron
-- run date. `bench_session_date` and `bench_source` make the bar's own session
-- and provider explicit, so NAV and benchmark can be joined only when both
-- represent the same market close.
--
-- `paper_performance.snapshot_type` separates the canonical EOD row from
-- premarket/intraday snapshots. PaperTrader ran a second same-day mark and
-- upsert over the same (date, market) key, so an intraday snapshot could
-- overwrite the EOD row. One canonical EOD writer per market; anything else is
-- a distinct, typed row.
--
-- NOT YET APPLIED. Every consumer of these objects is written to tolerate their
-- absence (optional-column retry / missing-relation tolerated on the ledger),
-- so this file may land before the migration runs without breaking the money
-- path — but nothing may DEPEND on them until it is verified applied.

BEGIN;

-- ── W4: append-only mark ledger ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.paper_position_marks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        text        NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  session_date  date        NOT NULL,
  market        text        NOT NULL CHECK (market IN ('us','india')),
  position_id   text        NOT NULL,
  symbol        text        NOT NULL,

  qty           numeric     NOT NULL,
  mark_price    numeric     NOT NULL,
  -- Provider (or explicit fallback) that produced the mark. A mark we cannot
  -- attribute is a mark we cannot audit, which is how 2026-08-12 became
  -- permanently unexplainable.
  source        text        NOT NULL,
  -- The mark's OWN observation time, not the time this run read it.
  observed_at   timestamptz,
  provenance    text        NOT NULL CHECK (provenance IN ('live_quote','carry_forward','entry_cost')),
  stale         boolean     NOT NULL,
  age_days      numeric,
  reason        text        NOT NULL,

  -- Detector, enforced by the database rather than by the caller's good
  -- intentions: a non-positive mark silently drops a position out of NAV, and
  -- an unattributed or unexplained mark defeats the entire purpose of the
  -- ledger. The DB refuses what the code should already have refused.
  CONSTRAINT paper_position_marks_qty_positive   CHECK (qty > 0),
  CONSTRAINT paper_position_marks_mark_positive  CHECK (mark_price > 0),
  CONSTRAINT paper_position_marks_source_present CHECK (length(btrim(source)) > 0),
  CONSTRAINT paper_position_marks_reason_present CHECK (length(btrim(reason)) > 0),
  -- A mark claiming to be a fresh quote must carry the observation time that
  -- makes that claim checkable.
  CONSTRAINT paper_position_marks_live_is_timestamped
    CHECK (provenance <> 'live_quote' OR observed_at IS NOT NULL),
  -- `stale` is derived, not free-form: only a live quote may be non-stale.
  CONSTRAINT paper_position_marks_stale_matches_provenance
    CHECK (stale = (provenance <> 'live_quote'))
);

CREATE INDEX IF NOT EXISTS paper_position_marks_run_idx
  ON public.paper_position_marks (run_id);
CREATE INDEX IF NOT EXISTS paper_position_marks_session_idx
  ON public.paper_position_marks (market, session_date DESC);
CREATE INDEX IF NOT EXISTS paper_position_marks_symbol_idx
  ON public.paper_position_marks (symbol, session_date DESC);

ALTER TABLE public.paper_position_marks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_position_marks_owner_read ON public.paper_position_marks;
CREATE POLICY paper_position_marks_owner_read
  ON public.paper_position_marks FOR SELECT
  TO authenticated
  USING (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

REVOKE ALL ON public.paper_position_marks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.paper_position_marks TO authenticated;
GRANT SELECT, INSERT ON public.paper_position_marks TO service_role;

-- Append-only: a later run must never be able to rewrite what an earlier run
-- observed. In-place mutation of the mark is the exact defect this replaces.
CREATE OR REPLACE FUNCTION paper_position_marks_no_mutate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'paper_position_marks is append-only';
END;
$$;

DROP TRIGGER IF EXISTS paper_position_marks_no_update ON public.paper_position_marks;
CREATE TRIGGER paper_position_marks_no_update
  BEFORE UPDATE OR DELETE ON public.paper_position_marks
  FOR EACH ROW EXECUTE FUNCTION paper_position_marks_no_mutate();

-- ── W5: benchmark session provenance on paper_performance ────────────────────

ALTER TABLE public.paper_performance
  ADD COLUMN IF NOT EXISTS bench_session_date date,
  ADD COLUMN IF NOT EXISTS bench_source       text,
  -- 'eod' is the canonical row written by PositionMonitor after the close.
  -- 'intraday' is a provisional placeholder PaperTrader may create ONLY when no
  -- row exists yet for that session; it must never overwrite an EOD row.
  ADD COLUMN IF NOT EXISTS snapshot_type      text NOT NULL DEFAULT 'eod';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_performance_snapshot_type_valid'
  ) THEN
    ALTER TABLE public.paper_performance
      ADD CONSTRAINT paper_performance_snapshot_type_valid
      CHECK (snapshot_type IN ('eod','intraday'));
  END IF;
END $$;

-- Detector: a benchmark level may not be stored against a portfolio row for a
-- different session. This is the constraint that would have rejected VOO's
-- 2026-08-11 close being written under 2026-08-12 and again under 2026-08-13.
-- NOT VALID so the existing contaminated rows (Jul 27 – Aug 14, already tainted
-- and deliberately not rewritten) do not block the migration; it is enforced on
-- every new and updated row from here on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_performance_bench_session_matches_date'
  ) THEN
    ALTER TABLE public.paper_performance
      ADD CONSTRAINT paper_performance_bench_session_matches_date
      CHECK (bench_nav IS NULL OR bench_session_date IS NULL OR bench_session_date = date)
      NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.paper_performance.bench_session_date IS
  'Market session the benchmark close belongs to. Must equal `date` — a benchmark may only be joined to a NAV representing the same close.';
COMMENT ON COLUMN public.paper_performance.bench_source IS
  'Provider that produced the benchmark daily bar (yahoo, massive, ...).';
COMMENT ON COLUMN public.paper_performance.snapshot_type IS
  'eod = canonical close row (PositionMonitor). intraday = provisional placeholder (PaperTrader), never overwrites an eod row.';

COMMIT;
