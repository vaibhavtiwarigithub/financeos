# Point-in-Time (PIT) Fundamentals — Feature Architecture

STATUS: DRAFT — awaiting owner approval
Owner: —
Author: architecture proposal (deep-audit P1 remediation)
Last updated: 2026-07-10

---

## 1. Problem statement

The research/scoring pipeline must use financial data **as it was known on the
decision date**. Today it does not. A revenue/EPS figure that is later restated
can retroactively change what a past decision "should" have seen, which corrupts
both backtests and the learning loop. This is a named **P1 gap** in the
deep-audit remediation.

Two distinct leaks exist, and the fix must address both:

- **Leak A — vintage leak on any re-fetch/backfill.** All fundamentals today are
  fetched as *current TTM snapshots with no report date or filing date attached*.
  If we ever re-score a past date, run a fundamentals-based backtest over history,
  or backfill, we pull **today's** (possibly restated) numbers and stamp them onto
  a past decision. There is no stored vintage to prevent this.
- **Leak B — unversioned evidence behind a frozen score.** The live score *is*
  frozen at decision time (see §3), but the fundamental inputs that produced it
  are stored as a loose JSON blob with no report-date / filing-date / vintage key.
  We cannot prove a stored score used as-known data, cannot detect when a later
  restatement changed the underlying TTM window, and cannot reconstruct the exact
  inputs for audit.

---

## 2. How fundamentals are fetched today (grounded in code)

### 2.1 Fetch path
- `lib/research-agent.ts` (`processSymbol`, ~L933–948) fetches all data in
  parallel. US fundamentals go through
  `fetchUsOverview(symbol, avFallback)` in **`lib/data/fundamentals.ts`**.
- `fetchUsOverview` calls `fetchFmpOverview` → FMP `ratios-ttm` +
  `key-metrics-ttm` (day-cached, own 250/day budget), falling back to Alpha
  Vantage `OVERVIEW` (`fetchAVOverview`, `lib/research-agent.ts` ~L734).
- India uses `fetchIndiaOverview` (Yahoo `quoteSummary`), see `lib/india-data.ts`.
- All three map into the **same AV-OVERVIEW-shaped `Record<string,string>`**:
  `PERatio`, `ProfitMargin`, `ReturnOnEquityTTM`, `EPS`,
  `QuarterlyRevenueGrowthYOY`, `AnalystTargetPrice`, `Sector`, etc.

**Key fact:** none of these fields carry a report period or filing date.
`ratios-ttm` / `key-metrics-ttm` / AV `OVERVIEW` are all *trailing-twelve-month,
as-of-now* rollups. AV `OVERVIEW` exposes only `LatestQuarter` (a single date on
the whole object, not per-field). So the current fetch layer is structurally
incapable of PIT — the date dimension is simply absent.

### 2.2 Scoring path
- `lib/data/scores.ts` → `scoreFundamentals(overview, isEtf, currentPrice)`
  (~L73–158) reads the OVERVIEW fields and produces a deterministic
  `fundamental_score` + an `evidence` object (`pe_ratio`, `profit_margin`,
  `roe`, `eps`, `revenue_growth_yoy`, `analyst_upside_pct`, `sector`, …).
- `computeScores` (~L296) assembles the 5 sub-scores and fire-and-forget writes
  `evidence_records` rows via `writeBatchEvidence` (fundamental payload, source
  `alpha_vantage`, `quality_state`). No date-of-record on the fundamental payload.

### 2.3 Persistence path (where evidence lands)
- **`agent_signals.signal_breakdown`** (jsonb) — per-dimension evidence for "today".
- **`decision_observations.features`** (jsonb) — the learning fuel. Written at
  `lib/research-agent.ts` ~L1370–1427. Already stamps
  `schemaVersion: "v1"` and `decisionTs` (ISO timestamp), and spreads
  `scores.evidence` (incl. the fundamental evidence). Table is **append-only,
  immutable** (trigger blocks UPDATE/DELETE — see `docs/arch/04-database-schema.md`).
- **`evidence_records`** — immutable, `payload_hash` dedup.
- **`signal_score_history`** — append-only per-symbol scores.

### 2.4 Learning / backtest consumers
- `lib/learning/dataset.ts` → `loadLabeledDataset` joins
  `decision_observations` × `observation_labels` and returns the **stored** scores
  + `availability_mask` + forward-return labels. `walkForwardFolds` does
  purge/embargo splitting. It **replays stored scores**, it does not re-fetch
  fundamentals — so today's learner is accidentally PIT-safe *for the score
  number*, but blind to whether that number's inputs were later restated (Leak B).
- `lib/validators/backtest.ts` (Validation Engine) similarly replays stored
  observations. Any *new* fundamentals-based factor or a re-score/backfill that
  re-hydrates fundamentals from a live provider would introduce Leak A.

**Net finding:** the frozen-score design already prevents the crudest leak for
the *existing* 5-dim replay. The exposure is (1) any future backfill / re-score /
fundamentals-driven backtest, and (2) the absence of a vintage key that lets us
audit or detect restatements. Both require capturing report-date + filing-date
and versioning restatements — the subject of this proposal.

---

## 3. Design

### 3.1 (a) Capture fundamentals with report-date AND as-of/filing-date

Every fundamental fact gets **three** dates:
- `report_period` (a.k.a. fiscal period end / report date) — *what period the
  number describes* (e.g. `2026-03-31`, Q1 FY26).
- `filing_date` / `accepted_date` — *when that number became public* (the SEC
  acceptance timestamp, or provider's `acceptedDate`/`fillingDate`).
- `captured_at` — *when Kairos first observed this value* (our own vintage clock).

The PIT rule for reads: a fact is **"known on date D"** iff
`filing_date <= D` (fall back to `captured_at <= D` when the provider gives no
filing date). Never `report_period <= D` alone — a period can end weeks before it
is filed, and using period-end would leak the not-yet-published number.

### 3.2 (b) Storage model that versions restatements (describe only — no DDL here)

Proposed new tables (append-only, following the existing ledger convention):

**`fundamental_facts`** — one immutable row per (symbol, metric window, vintage).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `symbol` | text | |
| `market` | text | `us` \| `india` |
| `metric_set` | text | `ttm_overview` (matches today's OVERVIEW rollup) \| `quarterly` \| `annual` |
| `report_period` | date | Fiscal period end the values describe |
| `fiscal_period` | text | `Q1`/`Q2`/`Q3`/`Q4`/`FY` (nullable) |
| `filing_date` | date | When it became public (nullable if provider omits) |
| `values` | jsonb | The OVERVIEW-shaped field map (`PERatio`, `ProfitMargin`, …) |
| `source` | text | `fmp` \| `alpha_vantage` \| `yahoo` \| `financialdatasets` |
| `restatement_seq` | int | 0 = as-first-observed; 1,2… = later restatements of the SAME `report_period` |
| `is_latest` | bool | Convenience flag: newest vintage for (symbol, report_period) |
| `payload_hash` | text | UNIQUE per (symbol, report_period, source, values-hash) — dedups identical re-fetches |
| `captured_at` | timestamptz | Our vintage clock |

Restatement handling: a new fetch for an existing `(symbol, report_period)`
whose `values` differ from the newest stored vintage inserts a **new row** with
`restatement_seq = prev+1` and flips the old row's `is_latest=false`. Nothing is
ever mutated in place — the original as-first-reported row survives forever. This
is what makes "a later-restated revenue must not retroactively change a past
score" enforceable.

**`fundamental_fetch_log`** (optional, ops) — every provider hit with
throttle/shape outcome, so a restatement can be traced to a specific fetch.

Also add, on `decision_observations.features` (no migration — it's jsonb):
- `fundamentals_vintage`: `{ fact_id, report_period, filing_date, restatement_seq, captured_at }`
  so each stored decision points at the exact immutable vintage it consumed.

### 3.3 (c) Read API — "fundamentals as known on date D"

New module **`lib/data/fundamentals-pit.ts`**:

```
getFundamentalsAsOf(symbol, market, asOf: Date, opts?): Promise<{
  overview: Record<string,string>;   // same shape scoreFundamentals reads today
  vintage: { fact_id, report_period, filing_date, restatement_seq, captured_at } | null;
  source: string;
}>
```

Query: newest `fundamental_facts` row for `symbol` where
`COALESCE(filing_date, captured_at) <= asOf`, ordered by that date desc then
`restatement_seq` **asc-at-or-before-asOf** (i.e. pick the vintage that was the
latest *known* one on `asOf`, not a future restatement). Returns the OVERVIEW map
untouched, so **`scoreFundamentals` needs zero changes** — it keeps reading a
`Record<string,string>`.

- **Live path** (`asOf = now`): `getFundamentalsAsOf(symbol, market, new Date())`
  simply returns the newest known vintage — behaviourally identical to today, but
  now it also writes/reads the vintage record.
- The existing `fetchUsOverview` becomes the **capture writer**: on each live
  fetch it upserts into `fundamental_facts` (append vintage on change), then
  hands the same overview to the caller. This is the single ingestion point.

### 3.4 (d) ResearchAgent + learning dataset consume it consistently

- **ResearchAgent (live):** replace the raw `fetchUsOverview(...).overview` at
  `lib/research-agent.ts` ~L948 with `getFundamentalsAsOf(symbol, market, now)`,
  and record `features.fundamentals_vintage`. Capture-on-fetch means live scoring
  builds the PIT archive as a side effect.
- **Learning dataset (`lib/learning/dataset.ts`):** unchanged for the *existing*
  5-dim replay (it already reads frozen scores — keep it that way). It gains one
  capability: when a future factor or the Validation Engine needs to *recompute* a
  fundamental at a historical decision, it MUST call
  `getFundamentalsAsOf(symbol, market, observation.ts)` — never a live fetch.
  Add a lint/guard note in `lib/validators/backtest.ts` that fundamentals in
  replay come only through the PIT read API. This is what makes backtest and live
  scoring agree: both resolve fundamentals through one date-parameterised function.
- **Restatement-drift detection (Leak B):** a periodic job can compare
  `decision_observations.features.fundamentals_vintage.fact_id` against the
  current `is_latest` vintage for that `report_period`; a mismatch flags the
  observation as *restated-after-decision* (surfaced to the learner as a taint
  signal, not a mutation). The stored score is never changed.

### 3.5 (e) Backfill strategy for existing history

We **cannot** reconstruct as-first-reported values for the past — no current
provider serves original-vs-restated history (see §4). Honest plan:

1. **Forward-only PIT from go-live.** Start capturing vintages now; the archive
   becomes correct from day one and compounds. Mark all pre-go-live decisions
   `pit_status = "pre_archive"` in features (they keep their frozen scores).
2. **Best-effort seed** for actively-traded symbols: one snapshot per current
   `report_period` using FMP `income-statement` / `financial-reports-dates`
   which *do* expose `date`/`fillingDate`/`acceptedDate` — stamped
   `restatement_seq = 0`, `source_note = "seed_latest_restated"` so it is never
   mistaken for a true first-report vintage.
3. **Never rewrite** existing `decision_observations` (append-only trigger forbids
   it anyway). Backfill only populates the new `fundamental_facts` table.

---

## 4. Data-source capability (does the provider expose filing dates / restated?)

| Provider (role today) | Report date | Filing date | Original-vs-restated |
|---|---|---|---|
| FMP `ratios-ttm` / `key-metrics-ttm` (**current US fundamentals**, `lib/data/fundamentals.ts`) | ❌ (TTM rollup) | ❌ | ❌ |
| FMP `income-statement` / `financial-reports-dates` (not used yet) | ✅ `date` / `calendarYear`+`period` | ✅ `fillingDate`, `acceptedDate` | ❌ (serves latest restated) |
| Alpha Vantage `OVERVIEW` (fallback) | ~ `LatestQuarter` only | ❌ | ❌ |
| FinancialDatasets `get_financial_metrics` / `get_income_statement` (MCP, referenced in a doctrine prompt but not wired) | ✅ `report_period` | partial | ❌ (latest restated) |
| Yahoo `quoteSummary` (India) | partial | ❌ | ❌ |
| Specialized PIT vendors (Compustat Point-in-Time, S&P) | ✅ | ✅ | ✅ | (out of budget/scope) |

**Conclusion:** no in-budget provider gives true as-first-reported history. The
only way Kairos gets real PIT is to **become its own point-in-time archive** by
snapshotting filing-date-stamped fundamentals on every fetch going forward, and
appending a new vintage row whenever values for a `report_period` change. Filing
dates ARE obtainable (FMP `income-statement.acceptedDate`, FinancialDatasets
`report_period`), so the capture side is feasible without a new paid vendor.

---

## 5. Phased build plan + effort

| Phase | Scope | Effort |
|---|---|---|
| **P0 — Schema** | `fundamental_facts` (+ optional `fundamental_fetch_log`) migration; verify applied via `list_migrations` before code ships (per CLAUDE.md schema rule). Update `docs/arch/04-database-schema.md`. | ~0.5 day |
| **P1 — Capture** | Make `fetchUsOverview` / `fetchIndiaOverview` upsert vintages (append-on-change, filing-date from FMP `income-statement` supplemental call, day-cached). Dedup via `payload_hash`. | ~1.5 days |
| **P2 — Read API** | `lib/data/fundamentals-pit.ts` `getFundamentalsAsOf`; unit tests against a hand-built multi-vintage fixture (mirrors `walkForwardFolds` test style). | ~1 day |
| **P3 — Wire live** | ResearchAgent consumes `getFundamentalsAsOf(now)`; stamp `features.fundamentals_vintage`. No change to `scoreFundamentals`. | ~0.5 day |
| **P4 — Replay guard** | Route all replay/backtest fundamentals through the PIT API; add restatement-drift detector + a `pit_restated_after_decision` taint signal for the learner. Update `docs/arch/09-learning-loop.md`. | ~1.5 days |
| **P5 — Backfill** | Forward-only default + best-effort seed for the active universe; `pre_archive` tagging. | ~1 day |

Total ≈ **6 engineer-days**, shippable phase-by-phase behind the existing
append-only-ledger conventions. Docs to touch on ship:
`docs/arch/04-database-schema.md` (P0), `docs/arch/02-tech-stack.md` (new FMP
endpoint / capture note), `docs/arch/09-learning-loop.md` (P4), and
`public/agent-diagrams/system-map.json` if the ResearchAgent→learner data flow
node descriptions change.

---

## 6. Effect on existing scores

- **No existing score changes.** `decision_observations` is append-only; frozen
  scores stay frozen. Live scoring output is numerically identical on go-live
  (same provider, same fields) — we only *add* a vintage record alongside.
- The learner gains a new *observed* taint feature (restated-after-decision); per
  CLAUDE.md's pushback mandate it is **logged evidence, not a new weighted
  dimension** until it earns an IC track record.

---

## 7. Risks / open questions

1. **Filing date availability & cost.** FMP `income-statement` gives
   `acceptedDate`, but it is a separate call — does the 250/day FMP budget absorb
   one more day-cached call per symbol? (Likely yes given day-cache; verify.)
2. **India filing dates.** Yahoo `quoteSummary` does not expose filing dates
   cleanly; India may have to fall back to `captured_at` as the as-of clock (still
   correct forward, just coarser). Acceptable?
3. **TTM windows don't have a single filing date.** A TTM rollup blends 4
   quarters; the honest `filing_date` for a TTM `metric_set` is the filing date of
   its *most recent* constituent quarter. Confirm that convention.
4. **Restatement detection sensitivity.** Provider re-computations / rounding can
   flip a value trivially. Need a tolerance threshold before appending a new
   `restatement_seq` vintage to avoid vintage churn.
5. **Should the seed backfill exist at all?** It stamps latest-restated values as
   `restatement_seq=0`, which is *not* truly first-reported — risk of it being
   mistaken for real PIT. Option: forward-only, skip seed entirely.
6. **`get_financial_metrics` (FinancialDatasets MCP) wiring.** It exposes
   `report_period` cleanly and could become the canonical PIT fundamentals source
   instead of FMP TTM. Bigger change; out of this proposal's default scope but
   noted as the strongest long-term option.

---

## 8. What this does NOT do

- Does **not** reconstruct as-first-reported fundamentals for history predating
  go-live — no in-budget provider offers that.
- Does **not** change `scoreFundamentals` math, the 5-dim weights, or any score
  value already stored.
- Does **not** add a new weighted scoring dimension (restatement taint is logged
  evidence only, per pushback mandate).
- Does **not** re-fetch or mutate `decision_observations` / `evidence_records`
  (append-only ledgers stay immutable).
- Does **not** purchase a specialized PIT data vendor (Compustat/S&P) — explicitly
  out of scope; flagged as the only path to true pre-history original-vs-restated.
- Does **not** cover point-in-time *prices* or *index membership* survivorship —
  separate audit items.
