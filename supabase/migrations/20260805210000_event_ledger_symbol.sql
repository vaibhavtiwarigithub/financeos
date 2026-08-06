-- Event ledger step 2 prep — per-symbol (idiosyncratic) events.
--
-- The step 1 vocabulary held only trade-policy events, which are market-wide and
-- therefore have no subject symbol. The guidance family added here is
-- IDIOSYNCRATIC: it applies to one company, which is precisely why it was chosen
-- over more macro types. A market-wide event has zero per-date cross-sectional
-- variance within the affected set, so it can only shift a composite's LEVEL,
-- never its ordering — the defect that disqualified NSE FII/DII in
-- features/india-scorer-discrimination/R3_DIMENSION_FEASIBILITY.md.
--
-- `symbol` is NULLABLE because both kinds share the table. Which types REQUIRE a
-- symbol is enforced in lib/events/vocabulary.ts (`requiresSymbol`) rather than
-- in a DB CHECK, so the rule lives beside the vocabulary it belongs to and does
-- not need a migration every time a type is added.
--
-- MEASUREMENT ONLY. No score, eligibility, sizing, entry, exit, promotion or
-- broker path reads this table.
--
-- Additive and idempotent.

ALTER TABLE public.market_events
  ADD COLUMN IF NOT EXISTS symbol text;

COMMENT ON COLUMN public.market_events.symbol IS
  'Subject symbol for idiosyncratic events (guidance, etc). NULL for market-wide events such as tariffs. Requirement per type is enforced in lib/events/vocabulary.ts.';

CREATE INDEX IF NOT EXISTS market_events_symbol_time_idx
  ON public.market_events (symbol, occurred_at DESC)
  WHERE symbol IS NOT NULL;

-- The step 1 UNIQUE (event_type, market, occurred_at) is wrong once symbols
-- exist: two different companies can cut guidance on the same day, and that is
-- two events, not a duplicate. Widen the key to include symbol.
--
-- NULLS NOT DISTINCT so the market-wide rows keep their original protection —
-- without it, every tariff row (symbol IS NULL) would compare unequal to every
-- other and the duplicate guard would silently stop working.
ALTER TABLE public.market_events
  DROP CONSTRAINT IF EXISTS market_events_event_type_market_occurred_at_key;

CREATE UNIQUE INDEX IF NOT EXISTS market_events_identity_key
  ON public.market_events (event_type, market, occurred_at, symbol) NULLS NOT DISTINCT;

-- Outcomes gain the series the return was measured from, so a stored number can
-- be re-derived rather than trusted. `entry_date` is the session the measurement
-- STARTS from: the first session whose close falls after occurred_at. Recording
-- it is what makes look-ahead auditable instead of assumed.
ALTER TABLE public.market_event_outcomes
  ADD COLUMN IF NOT EXISTS entry_date date,
  ADD COLUMN IF NOT EXISTS exit_date  date,
  ADD COLUMN IF NOT EXISTS subject_symbol text,
  ADD COLUMN IF NOT EXISTS sessions_used int;

COMMENT ON COLUMN public.market_event_outcomes.entry_date IS
  'First session whose close falls strictly after market_events.occurred_at. The anti-look-ahead anchor: a forward return may never begin before this.';
