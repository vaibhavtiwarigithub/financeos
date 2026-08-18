# Duration Signal — Measurement Only

**Status:** DRAFT PROPOSAL — not approved, not implemented.
**Date:** 2026-08-18
**Scope:** measure whether a duration (bond) signal has predictive power. No sizing, no orders, no allocation.

## Why this exists

Asked: does Kairos recommend buying bonds when bonds rally, and plan entries/exits?
Answer, verified against production: **no**.

- `TLT, IEF, SHY, HYG, LQD, BND, AGG, GOVT` — **never scored, never traded**. Zero rows
  in `decision_observations` and `paper_trades`.
- Only `SGOV` (56 obs) and `GLD` (53 obs) exist from that family. SGOV is an
  ultra-short T-bill fund — a cash equivalent, not a duration position.
- `strategy_sleeves` carries a `defensive_etf` sleeve (SHY/IEF/TLT/GLD, 20% target,
  `enabled=true`), but `computeAllocation` returns null unless
  `strategy_config.allocation_enabled=true`, which is **false**. Even when enabled,
  `paper-trade/route.ts` reads only the **equity** sleeve, and only to TIGHTEN the
  equity cap. Nothing buys the defensive sleeve.
- `TLT/IEF/HYG` in `price-cache-fill`'s REGIME list is tracking only; it feeds no
  buy decision. MacroSentinel's regime score feeds the macro DIMENSION of an
  equity score; nothing maps it to duration.

## Why NOT to route bond ETFs through the existing scorer

This is the central design decision. Scoring `TLT` with today's pipeline would
produce a number that looks like evidence and is not.

1. **A fabricated fundamental.** `scoreFundamentals` returns a flat **55** for any
   ETF ("no company fundamentals; neutral 55 baseline") and
   `fundamentalDataAvailable: isEtf || …` marks it **available**. So a constant
   enters at 30% base weight and is counted as real evidence. `v_decision_quality`
   meanwhile lists ETF applicable dims as `[technical, sentiment, macro]` —
   excluding fundamental. Two sources disagree about the same decision, which is
   exactly the defect fixed in `20260817200000_decision_quality_single_source`.
2. **Equity technicals do not describe duration.** RSI/EMA/ADX on TLT measure price
   momentum of a rates instrument; the actual drivers are level, slope, real
   rates, and policy expectations.
3. **Macro is a 15% side input** when for duration it is the whole thesis.
4. **Sentiment is StockTwits chatter** on a bond fund — thin to meaningless.
5. **The exit mandate does not fit.** A bond ETF would inherit the equity swing
   mandate: 8% target, 7% stop, 10-day horizon. TLT rarely moves 8% in ten
   sessions, so the target would be structurally unreachable — the exact defect
   documented in `docs/audits/2026-08-17-exit-policy-counterfactual.md`, rebuilt
   knowingly.

**Therefore: a separate, isolated measurement lane. Not a new symbol class in the
equity screener.**

## Proposed architecture

### Isolation boundary (the load-bearing rule)

Modelled on the Property/Investing invariant in `docs/arch/08`: the dependency runs
ONE WAY. Duration observations are written and read only by this lane. **No
securities score, eligibility gate, sizing rule, order path, exit, promotion gate,
learner, or broker call reads them.** Enforced by a coupling test in the style of
`tests/risk-research-annotation.test.ts` (which pins invariant R1 and is itself
falsification-tested), not by convention.

### Data — zero new providers, zero new keys, zero cost

| Input | Source | Already integrated? |
|---|---|---|
| 2y / 10y yields (`DGS2`, `DGS10`) | FRED | yes — `FRED_SERIES` |
| Fed funds, target range | FRED | yes |
| CPI (real-rate proxy) | FRED | yes |
| TLT / IEF / SHY daily bars | Yahoo chart | yes — keyless, unbudgeted, unpaced |

FRED and Yahoo both carry `dailyBudget: null`. This adds no load to the AV (25/day)
or EODHD (20/day) tiers.

### Features (deterministic, no LLM)

Level (`DGS10`), slope (`DGS10 − DGS2`), 20-day change in each, policy gap
(`DGS2 − FEDFUNDS`), and a real-rate proxy (`DGS10 − trailing CPI YoY`). Each
carries its own FRED observation date — a monthly series is stamped with the period
it belongs to, never the run date. Missing input ⇒ the feature is **unavailable**,
never a neutral placeholder. That rule is the whole point of the lane.

### Storage

New table `duration_observations` (append-only), plus forward labels at h5/h10/h20/h60
reusing the existing label contract (`LABEL_COST_HAIRCUT`, forward-window coverage
from `lib/learning/label-window.ts`). A separate table — not a `market` tag on
`decision_observations` — so no existing consumer can pick these rows up by accident.

### Predeclared evidence floor — set BEFORE any data exists

Copying the discipline already enforced in `aggregateAtrExitEvidence`:

- date-clustered IC (one decision date = one draw; same-day observations share a shock)
- `n >= 60` AND `nEffective = n / horizonDays >= 12`
- below that the lane reports `insufficient_sample` and **may not be cited as evidence**

### Kill condition — also predeclared

If, after the floor is met, date-clustered IC is indistinguishable from zero at
|t| < 2, the lane is **deleted, not tuned**. Written down now so it cannot be
relaxed once the data is in.

## Operator view

**Steelman.** Duration is a genuinely different return driver, the FRED inputs are
already paid for, and measurement-only is cheap. If a real signal exists, a
future defensive sleeve would have evidence behind it instead of a hunch.

**Counter, and my recommendation.** The equity book has ~16 clean US sessions, no
demonstrated edge, and both markets sit far below the `nEffective >= 12` floor for
the strategy that already exists. Retail duration timing is also a crowded,
well-studied space where the honest prior is "hard". The real cost here is not
compute — it is attention: a second asset class multiplies the measurement burden
before the first one is measurable.

**I would defer this** until the equity book clears its own evidence floor. If it
is built anyway, it must stay a measurement lane with the isolation test and the
kill condition, so it cannot quietly become a sizing input.

## Explicitly NOT in scope

No sizing. No orders. No allocation change. No `strategy_sleeves` activation.
No `allocation_enabled` flip. No change to the equity screener, mandate, or exits.
Nothing in this lane may be read by the money path.

## Open questions for the owner

1. Build now, or defer until the equity book clears its floor? (I recommend defer.)
2. US only, or India too? India has no FRED equivalent; the India branch would need
   a different rate source and is not costed here.
3. Should the ETF fundamental-55 inconsistency be fixed separately? It affects the
   ETFs already being scored today (SGOV, GLD, XAR, VOO), independent of this lane.
