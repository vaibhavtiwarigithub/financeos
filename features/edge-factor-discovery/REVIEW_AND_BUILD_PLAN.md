# Edge/Factor Discovery — Review of ChatGPT's response + concrete build plan

Date: 2026-07-08. Author: Claude (Kairos).
Reviews: `FEATURE_ARCHITECTURE.md` (as revised by ChatGPT) + `CHATGPT_RESPONSE.md`.

---

## 1. Review verdict

ChatGPT's corrections are **accepted** — they make the design safer and more
credible:

- **ThemeScout = discovery only** (already reverted in code to a plain news scout).
- **EdgeScout/FactorScout = the deterministic alpha factory** (new).
- **Lifecycle** `candidate → measure_only → shadow → exploratory_paper →
  active_paper → live_eligible → live_approved` — good; allows learning without
  pretending an edge is proven.
- **Regime = continuous size scaler first**, hard on/off only later with evidence
  + owner sign-off. This also **resolves the CLAUDE.md "no explicit regime" locked
  rule** — a scaler is not a bull/bear switch, so no rule violation for the first
  cut. (Hard on/off still needs explicit owner re-approval later.)
- **Point-in-time data as a first-class gate** (`edge_signal_inputs` audit) — this
  is the single most important correctness addition; look-ahead bias is what makes
  most retail factor backtests fake.
- **Stricter multiple-testing for discovered vs. priored factors** (t>3 / FDR for
  data-mined; t≈2 ok for known priors) + Newey-West for overlapping returns.
- **Long-only top-bucket-vs-cash-after-cost** as the decisive test (we are not
  long/short) — correct and often omitted.
- **Start with 8–10 edges, not 60** — correct anti-overfit discipline.

### Codebase reality-check (reuse anchors verified)
The doc's "reuse, don't rebuild" claims hold, with **path corrections**:

| Doc says | Actual | Status |
|---|---|---|
| Feature Registry whitelisted grammar | `lib/validation/feature-compiler.ts` | ✅ exists — host edge formulas here |
| shadow_decisions | migration `065_shadow_decisions.sql` + `lib/research-agent.ts` | ✅ exists — P2 shadow reuses it |
| Validation Engine (WFO/MC) | `lib/validation/engine.ts` + `app/api/agents/backtest/*` | ✅ exists — extend for edge composite |
| genome + learner (weights) | `lib/validation/genome-live.ts`, `lib/validation/genome.ts` | ✅ exists — composite weights plug in |
| historical candles for IC | `lib/data/candles.ts` | ✅ exists — broad-universe IC source |
| research-agent 5-dim score | **`lib/research-agent.ts`** (NOT `lib/agents/research-agent.ts`) | ✅ doc path corrected |
| universe/screener | `lib/research-agent.ts` gatherSymbols, `lib/india-universe.ts`, `lib/nse-data.ts` | ✅ exists |

**Action completed:** fixed the path references in `FEATURE_ARCHITECTURE.md §11`
(`lib/research-agent.ts`, `lib/validation/feature-compiler.ts`,
`lib/validation/engine.ts`).

### Two additions I'd make to ChatGPT's plan
1. **IC must be computed on the BROAD historical universe from `candles.ts`, not on
   our ~handful of filled paper trades.** Our paper history is far too small for a
   meaningful IC. Live paper is *confirmation*, not the IC sample. (The doc says
   this in §13; elevate it to a P0 hard requirement.)
2. **Universe definition is itself a decision** (survivorship bias): the P0
   universe must be a point-in-time membership list, not "today's tickers applied
   to history." For P0 measure-only we can start with a fixed liquid set + a
   `universe_id` column and improve PIT membership in P1. Flag explicitly.

---

## 2. Build plan (phased, matches the doc's P0–P6)

Only **P0 + P1 are specced to implement now** (both measure-only, zero trading
impact). P2+ are gated on what P1's IC scorecards actually show — no point wiring
a composite score into anything until we know an edge has real IC.

### P0 — Edge library + signal store (measure-only) — BUILDABLE NOW

**Migration 132 (additive, no money tables):**
- `edge_catalog(edge_id text pk, name, category, formula_spec, inputs jsonb,
  rationale, expected_sign, horizon_days, data_source, references jsonb,
  status text default 'candidate', created_at)`
- `edge_universe_members(universe_id, market, symbol, as_of_date, source,
  included_reason, created_at)` — records the exact eligible universe snapshot.
  Unique `(universe_id, market, symbol)`.
- `edge_signals(id, symbol, date, edge_id, market, raw_value, z_value,
  universe_id, created_at)` — unique(symbol,date,edge_id,market); index(date,market,edge_id)
- `edge_signal_inputs(id, edge_signal_id fk, input_name, source, as_of_date,
  available_at, revised_at, adjustment_policy, raw_ref)` — PIT audit. Unique enough
  to make reruns idempotent, e.g. `(edge_signal_id,input_name,source,as_of_date)`.
- `edge_ic_history(...)` (created here, populated in P1)
- Verify applied via information_schema before the compute job reads them.

**`lib/edges/` (new):**
- `types.ts` — `Edge { id, category, horizon, expectedSign, compute(ctx) }`,
  `EdgeContext { symbol, market, asOf, candles, benchmarkCandles }`.
- `registry.ts` — the P0 edge set (price/volume first, PIT-safe):
  1. 12-1 momentum (skip last month) — US + India
  2. Relative strength vs index (SPY/NIFTY) — US + India
  3. 50/200DMA trend + slope — US + India
  4. Volatility-adjusted momentum (mom / realized vol) — US + India
  5. Short-term reversal in uptrend — US + India
  6. 52-week-high proximity — US + India
  7. Volume breakout / volume acceleration — US + India, only when volume data is
     present and sufficiently complete
  8. Optional low-volatility / realized-volatility rank — US + India
- `standardize.ts` — cross-sectional winsorize + z-score per (date, market, edge).
- `compute.ts` — runs the registry over the universe for a date, returns rows +
  input-audit rows. Pure; reads only historical candles/benchmarks. **No
  fundamentals in P0.**

**Universe source (P0):**
- Use a bounded liquid set and record it into `edge_universe_members` for each
  `universe_id`. Recommended first slice: current research-enabled US watchlist +
  current US screener candidates + current India `india_screen_cache` top liquid
  names, capped by explicit `maxSymbols` defaults.
- Do **not** claim PIT index membership yet. The `universe_id`/membership table
  makes the survivorship limitation explicit until a true PIT membership source is
  wired.

**Provider/budget guardrail (P0):**
- Backfill must be bounded: explicit `maxSymbols`, `maxDays`, and `market`.
- Prefer existing `price_cache` / cached candles first. Do not fire unbounded
  external candle requests across S&P 500/NIFTY 200 from a serverless route.
- If external fetch is needed, it must use the existing provider budget/cache
  layer and return a partial-result report instead of retrying indefinitely.

**Job:** `app/api/agents/edge-scout` (owner-or-cron). Measure-only: computes
edge_universe_members + edge_signals + edge_signal_inputs. Optional bounded
backfill params, e.g. `market=us&from=YYYY-MM-DD&to=YYYY-MM-DD&maxSymbols=50`.
**No `agent_signals`, no fills, no score change.** Add a `kairos-edge-scout` cron
later (after P0 proves out); for P0 it can be run manually/owner-triggered.

**Dashboard (read-only):** an "Edge Catalog" panel — list edges + status + latest
z-values per symbol. (IC columns added in P1.)

**Definition of done (P0):** migration applied+verified; bounded edge_signals
populated for a recorded US+India universe snapshot; input-audit rows present;
rerunning the same request is idempotent; provider usage is bounded and reported;
zero change to any trading/scoring/money path; build+typecheck green.

### P1 — IC/IR gate + scorecard (measure-only) — BUILDABLE after P0

- `lib/edges/ic.ts` — rank IC (Spearman) vs forward returns by horizon (1/5/10/20d)
  from candles; mean IC, IC vol, IR, **Newey-West t-stat** (overlapping returns),
  decay curve, net-of-fee IC (apply the Build-4a modeled slip + a turnover est).
- Writer → `edge_ic_history`; lifecycle classifier may compute a **recommended**
  next state (`candidate→measure_only→shadow`) but must not auto-promote any edge
  into a state that affects scoring, paper sizing, or live eligibility.
- Dashboard: IC scorecard per edge (rolling IC chart, IR, t, decay, status) —
  read-only. **This is the payoff: it tells us whether ANY current idea has edge.**

### P2–P6 (specced in FEATURE_ARCHITECTURE.md, NOT now)
Shadow composite → exploratory paper (tiny caps) → regime scaler → active paper →
live (WFO/MC/long-only-alpha/owner). Each gated on the prior phase's evidence.

---

## 3. What P0/P1 explicitly do NOT touch
- `agent_signals`, paper-trade fills, sizing, genome, `analyst_score` — unchanged.
- ThemeScout stays the plain news scout (already reverted).
- No new money-table columns; no live-order path change.
- Regime filter — not in P0/P1 (P4).

## 4. Decisions locked for P0
1. **Universe for P0:** use a bounded liquid/current-tradable universe and record
   every member in `edge_universe_members`. Do not claim true PIT index membership
   yet; the limitation must be visible in the UI/report.
2. **Fundamentals:** defer FCF/earnings-yield/quality until a point-in-time
   fundamentals source with reliable `available_at` dates is wired. P0 is
   price/volume only.
3. **Provider usage:** no unbounded S&P 500/NIFTY 200 external candle sweep from a
   serverless route. Use cached data first; cap symbols/days; report partials.
4. **Effort:** P0 ≈ 1 migration + `lib/edges/*` + one measure-only route + a read
   panel. P1 ≈ IC math + scorecard. Both are self-contained and reversible.

**Recommendation:** build **P0 with price/volume edges only**. It is the smallest
measure-only slice that starts producing IC evidence with zero trading risk.
