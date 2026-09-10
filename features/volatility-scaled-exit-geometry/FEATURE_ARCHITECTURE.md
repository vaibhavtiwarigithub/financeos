# Volatility-Scaled Exit Geometry

> Status: **PROPOSED — architecture only.** No scoring, sizing, stop, target,
> paper or live-order behavior changes are authorized by this document.
> Last revised: 2026-09-10.
> Money-path influence: **none** until Stage 2 is separately approved.

## 0. The problem, measured

Every symbol in a market gets the **same** stop and target. Not "a default that
adapts" — literally one row per market:

| market | stop | target | horizon | R:R |
|---|---|---|---|---|
| US | 7% | 8% | 10d | **1.14 : 1** |
| India | 7% | 8% | 10d | **1.14 : 1** |

Source: `trading_mandates`, one row per market, set by the owner 2026-08-03
(US version 4, India version 3).

`resolveExecutionRiskReward` (`lib/trading/trade-plan.ts:99`) returns
`source: "mandate"` and `bindTradePrices` multiplies it against the fill price.
No volatility, ATR, beta, price level, liquidity or sector term enters.

### Why a flat percentage is the wrong shape

A fixed percentage is a **different bet on every symbol**, because the same
percentage is a different number of standard deviations depending on the name:

- a 2%-daily-ATR utility: a 7% stop is ~3.5 ATR — rarely touched by noise, but
  each loss is large relative to the move that caused it;
- a 6%-daily-ATR semi: a 7% stop is ~1.2 ATR — touched by ordinary intraday
  noise, so the position is stopped out repeatedly before the thesis resolves.

The system therefore takes systematically *more* risk-of-ruin-per-trade on quiet
names and systematically *more* whipsaw on volatile ones, while reporting a
single "7% stop" as if it were one policy. It is not one policy; it is an
unmanaged spread of policies.

The 1.14:1 reward-to-risk compounds this: it needs a **~47% win rate before
costs** just to break even, and that bar is identical for a high-conviction
setup and a marginal one.

### What already exists

| Component | State |
|---|---|
| `lib/trading/exit-stop-shadow.ts` | Measure-only. Tests H1: 2.8 ATR stop vs the mandate stop, target held identical. Sidak-adjusted for the 14-arm family it was selected from. **Corrected 2026-09-10** to read the live mandate — it previously hardcoded 7.5%/19.2% and called it "exactly as deployed". |
| `lib/trading/exit-geometry-shadow.ts` | Barrier resolution + counterfactual replay over matured labels. |
| `resolveExecutionRiskReward` ledger percentile | Would override the mandate from realized MAE/MFE percentiles — but requires `n >= 60` closed trades and is **portfolio-wide, not per-symbol**. Has never fired. |
| Anything ATR in a live path | **None.** `atr` appears only in the two shadow modules. |

So the machinery to evaluate this exists; the evidence does not yet.

## 1. Non-goals

- No change to any live or paper stop, target, horizon or size in Stages 0–1.
- No per-symbol *score* change. This is exit geometry only.
- No new provider dependency: ATR is computed from bars already cached.
- No replacement of the trailing-stop ladder (`lib/trading/exit-ladder.ts`).
  The ladder consumes whatever initial stop it is given; this proposal changes
  where that number comes from, not how the trail ratchets.
- No claim that ATR is the right volatility estimator. It is the one already
  implemented and already under test.

## 2. Proposed staging

### Stage 0 — accumulate honest evidence (no code change beyond what shipped)

The corrected shadow must now run against the deployed geometry and accumulate
matured labels. Until it does, there is nothing to decide on.

Exit criteria:
- `exit_stop_shadow_runs` rows with `matches_live_mandate = true` and
  `status = 'measured'` for **both** markets, proven separately;
- `effective_observations >= MIN_EFFECTIVE_OBSERVATIONS` per market;
- the two pre-existing rows (2026-09-06, `matches_live_mandate = false`) are
  excluded from any conclusion — they measured a 19.2% target that was never
  deployed.

**Do not raise the shadow's cadence to force this.** It reads matured labels;
running it daily recomputes the same cohort and invites peeking at a moving
result. Weekly is correct — the constraint is label maturation, not compute.

### Stage 1 — shadow the full geometry, not just the stop

H1 varies only the stop. That was the right first cut, but a 1.14:1 R:R means
the **target** is at least as suspect as the stop. Stage 1 adds arms that vary
target with volatility, with the stop held at the mandate value, so the two
terms are never confounded in one arm.

Every arm is predeclared and counted in the multiple-testing family. The Sidak
adjustment must be recomputed for the *new* family size — silently reusing
`TRIALS_CONSIDERED = 14` after adding arms would understate the threshold.

### Stage 2 — separately proposed switch

Only after Stage 1 has matured labels and no quality regression may a separate
architecture propose changing `resolveExecutionRiskReward`. It must state:

- the exact geometry function and its bounds;
- a **frozen, read-only counterfactual** showing which historical decisions flip,
  per market, before any live formula changes (Scoring Data-Truth Protocol §6);
- US and India proven separately (§7) — India's ATR distribution and tick/
  circuit-limit rules differ and cannot be validated by a pooled result;
- rollback: the mandate row stays the fallback, so reverting is a config change.

## 3. Open questions for the owner

1. Is the 1.14:1 R:R deliberate? A 7%/8% pairing is unusual for a 10-day swing
   horizon and may simply be a stale setting rather than a chosen policy. This
   is worth answering *before* spending evidence on the stop term.
2. Should volatility scaling bound the *position size* instead of, or as well
   as, the stop? Equal-risk sizing (smaller position on a wider stop) achieves
   much of the same risk normalization without touching exit geometry, and the
   flat `position_size_pct` cap has the identical one-size-fits-all defect.
3. Minimum-tick and circuit-limit handling for India before any ATR stop is
   allowed to produce a price there.

## 4. Acceptance criteria

- [ ] No live stop, target or size changed by Stages 0–1.
- [ ] Every persisted shadow row stamps the geometry it measured
      (`baseline_stop_pct`, `baseline_target_pct`, `candidate_stop_atr`,
      `matches_live_mandate`) — shipped 2026-09-10.
- [ ] Conclusions cite only rows with `matches_live_mandate = true`.
- [ ] US and India reported separately, never pooled.
- [ ] The multiple-testing family is recounted whenever an arm is added.
- [ ] A frozen counterfactual exists before any Stage 2 formula change.
