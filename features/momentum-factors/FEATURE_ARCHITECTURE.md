# Momentum / Growth Factors — Feature Architecture

> **STATUS: DRAFT — NOT APPROVED.** Proposal for review. No code until explicit sign-off.
> Owner decision pending. Created 2026-07-10.

## 1. Problem

The live `deterministic_v1` scorer is tilted **value + mean-reversion** and structurally
**fades** the exact stocks that become multibaggers (Micron, SanDisk, NVDA, Intel-type
cycle-turn / re-rating moves):

- RSI curve peaks at 60–72 and **penalizes RSI > 75** — hype movers run overbought for weeks.
- P/E dimension marks high-multiple growth names "expensive" — the re-rating engine (earnings
  acceleration) isn't measured, only the P/E *level*.
- No **relative strength** vs market/sector (the top empirical momentum factor).
- No **earnings-estimate revision** momentum (the re-rating driver).
- No **revenue/earnings acceleration** (2nd derivative — the cycle-turn detector).
- No **52-week-high proximity / breakout / volume accumulation**.

We want to *catch* these earlier — WITHOUT curve-fitting to a handful of remembered winners
(survivorship) and without turning a value engine into a muddle that does neither job well.

## 2. Non-goals / guardrails (push-back mandate)

- **Not** a hardcoded "hype detector." Every new factor must clear the existing IC gate
  (EdgeScout/EdgeIC, `lib/edges/*`) on the broad universe before it can influence live scoring —
  the same gate that already correctly rejected the naive price/volume edges as noise.
- **Not** a replacement for the value/quality dimensions. Momentum is ADDED; the champion
  **weights** (per market) decide when it dominates — that's what the learning loop is for.
- **No** look-ahead. All factors computed point-in-time from data available at decision time.
- **No** money-path change. Scoring only; sizing/gates/broker untouched.

## 3. Proposed factors (all deterministic, 0–100 or z-scored)

| Factor | Definition | Data source |
|---|---|---|
| Relative strength | stock total return − benchmark return over 1/3/6mo, percentile-ranked | daily series (have) + SPY/^NSEI |
| Estimate revision | Δ consensus EPS/target over 30/90d (up = bullish) | FinancialDatasets / AV estimates |
| Revenue acceleration | sign+magnitude of QoQ growth 2nd derivative | FinancialDatasets income statements |
| Earnings acceleration | same on EPS | FinancialDatasets |
| 52w-high proximity | `price / 52w_high` (breakout tell) | daily series (have) |
| Volume breakout | volume z-score on up-days vs base | candles (have) |

## 4. Two architecture options (decide at review)

**Option A — new 6th dimension `momentum_score`.**
Aggregate the factors into one 0–100 dimension; extend the weight vector to 6, extend champion
`weights_snapshot`, validation replay, and genome. Cleanest conceptually; touches the weight
schema + validation contract (bigger blast radius).

**Option B — factors as IC-gated *features* feeding existing dimensions (RECOMMENDED).**
Each factor enters `feature_registry` (migration 064), is IC-validated via the edge lab, and on
promotion contributes to the **technical** (RS, 52wH, volume-breakout) or **fundamental**
(estimate revision, acceleration) dimension via the whitelisted compiler. No new weight slot; the
governed discovery path we already built does the work. Slower to "turn on," but validation-first
and reversible.

Recommendation: **B** — it's the path the learning-core was built for and avoids overfitting.

## 5. Archetype interaction

`lib/scoring/archetypes.ts` already exists. A "momentum/breakout" archetype would stop hard-fading
high RSI *when* RS + acceleration confirm — regime/archetype-routed, not global. In scope as a
follow-on once ≥1 momentum factor is IC-promoted.

## 6. Validation gate (hard requirement)

No factor influences a live score until: IC |ρ| ≥ threshold with Newey-West t-stat, out-of-sample
across walk-forward folds, on the **broad** universe (not the 4 winners). Fail-closed. This is the
antidote to survivorship.

## 7. Phasing

- **P0** — compute + log the 6 factors as shadow evidence on every candidate (no score effect).
- **P1** — IC-measure each in the edge lab; promote only those that clear.
- **P2** — wire promoted factors into their dimension (Option B) or the 6th dimension (Option A).
- **P3** — momentum archetype (conditional RSI-fade removal); let per-market weights adapt.

## 8. Open questions for review

1. Option A (new dimension) vs B (IC-gated features)?
2. Benchmark for RS: SPY/^NSEI only, or sector ETF too?
3. Estimate-revision data: FinancialDatasets sufficient, or add a second source?
4. Acceptable AV/FD budget increase for the new fetches (day-cache + budget guard applies)?
