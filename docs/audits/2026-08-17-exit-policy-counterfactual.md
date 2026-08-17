# Exit-policy counterfactual — frozen evidence

**Date:** 2026-08-17
**Status:** READ-ONLY EVIDENCE. No live formula changed. No historical decision rewritten.
**Policy version:** `close_observed_v1` (`lib/learning/atr-exit-evidence.ts`)
**Verdict:** **DO NOT CHANGE THE LIVE EXIT FORMULA ON THIS EVIDENCE.**

---

## Why this exists

The live exit policy pairs a **+20% price target** with a **−7% stop** and a
**10-day time stop**. Diagnosis on 2026-08-17 found the target has **never fired
once in 135 closed trades**. Per the Scoring Data-Truth Review Protocol, a live
money-path formula may not change without a frozen, read-only counterfactual
showing the expected flips first. This is that counterfactual.

## The defect being tested

Zero `target_hit` exits across 135 closed trades, both markets. Reachability of
+20% within the hold window, across 1,885 matured labels:

| Market | Horizon | n | avg MFE | p90 MFE | max MFE | ever ≥ +20% |
|---|---|---|---|---|---|---|
| US | h10 | 1,120 | 5.76% | 11.82% | 46.11% | **3.8%** |
| US | h20 | 428 | 6.62% | 13.53% | 74.98% | 6.3% |
| India | h10 | 244 | 5.37% | 12.13% | **18.44%** | **0.0%** |
| India | h20 | 93 | 7.32% | 16.19% | 21.99% | 2.2% |

The target sits at roughly **3.5× average MFE and above the 90th percentile**.
India has *never once* touched +20% within a 10-day window in 244 labels.

Operationally the live policy is therefore *"hold 10 days, or stop at −7%"* —
the target is inert. **This is a structural fact, not a statistical claim.**

**Consequence for W2-full:** the partial-exit path restored on 2026-08-17 is
gated on this same `priceTarget`. It will fire on ~4% of US and ~0% of India
positions. The feature is near-inert as shipped.

## Counterfactual construction

- Engine: `simulateAtrExitPolicy` — **already existed**, not written for this.
- **Close-observed only.** No intraday touch order is inferred and no barrier
  price is assumed executable. Exits trigger only on a completed session close,
  matching the real PositionMonitor cadence.
- **Cost haircut applied** to counterfactual returns (`LABEL_COST_HAIRCUT`,
  10bps round trip). Live `realized_pnl_pct` is gross. The comparison is
  therefore **conservative against** the counterfactual policies.
- Three **predeclared** policies (declared before this analysis, unchanged):
  `tight_1_0_1_5_2_5_0_5`, `balanced_1_5_2_0_3_0_1_0`, `wide_2_0_2_5_4_0_1_5`.
- Paired per trade against the live realized outcome, then averaged per decision
  date. **One decision date = one independent draw** (same-day entries share a
  market shock).

## Result — per trade

Horizon h10. Live avg is the realized outcome on the same trades.

| Market | Policy | n | dates | live avg | cf avg | delta | better | partials fired | targets hit |
|---|---|---|---|---|---|---|---|---|---|
| India | wide | 43 | 10 | +2.10% | +3.29% | **+1.19pp** | 28/43 | 14 | 10 |
| India | balanced | 43 | 10 | +2.10% | +2.45% | +0.35pp | 25/43 | 9 | 12 |
| India | tight | 43 | 10 | +2.10% | +2.06% | −0.04pp | 23/43 | 14 | 13 |
| US | wide | 25 | 7 | −1.23% | −0.30% | **+0.93pp** | 14/25 | 2 | 2 |
| US | tight | 25 | 7 | −1.23% | −0.71% | +0.52pp | 15/25 | 6 | 2 |
| US | balanced | 25 | 7 | −1.23% | −0.98% | +0.25pp | 14/25 | 3 | 2 |

Every policy beats or matches live in both markets. `wide` is best in both.
**Targets and partials actually fire** (10–13 target hits in India) versus zero
under the live +20%.

## Result — date-clustered, the number that decides

| Market | Policy | dates | delta | sd | clustered t | dates better |
|---|---|---|---|---|---|---|
| US | wide | 7 | +0.97pp | 1.90 | **1.35** | 5/7 |
| India | wide | 10 | +1.20pp | 3.14 | **1.21** | 7/10 |
| India | balanced | 10 | +0.38pp | 2.51 | 0.48 | 7/10 |
| US | tight | 7 | +0.18pp | 1.37 | 0.35 | 3/7 |
| US | balanced | 7 | +0.10pp | 0.74 | 0.34 | 5/7 |
| India | tight | 10 | −0.60pp | 2.26 | −0.84 | 5/10 |

**Nothing is significant.** Best is US `wide` at t=1.35 (p≈0.23). Six cells were
examined, so multiple-testing correction would push the bar further out.

Note India `tight` moves from −0.04pp per-trade to −0.60pp per-date — clustering
changes both magnitude and conclusion, exactly as it did in the morning's
analysis.

## The predeclared floor already rejects this

`aggregateAtrExitEvidence` gates reviewability on a threshold declared **before**
any of this data existed:

```ts
status: n >= ATR_EXIT_MIN_LABELS /* 60 */ && nEffective >= 12
  ? "reviewable_evidence" : "insufficient_sample"
```

`nEffective = n / horizonDays` corrects for overlap — daily observations over
10-day windows are not independent draws.

| Market | n | nEffective (h10) | needs | status |
|---|---|---|---|---|
| US | 25 | **2.5** | ≥12 | `insufficient_sample` |
| India | 43 | **4.3** | ≥12 | `insufficient_sample` |

Both markets sit at roughly 21% (US) and 36% (India) of the required evidence.
Reaching `reviewable_evidence` at h10 needs **n ≥ 120** per market.

This floor is honored rather than argued around. A t=1.35 does not override a
threshold that was set before the data was seen — that is the precise mechanism
by which strategies get tuned on noise.

## Verdict

1. **The dead target is a real, established defect.** 0/135 firings and
   0.0–3.8% reachability across 1,885 labels is structural, not statistical.
   It needs fixing on the argument that *a target should be reachable*.
2. **Whether the ATR family improves returns is NOT established.** Max t=1.35.
   Do not flip the live formula on this.
3. These are separable. Fixing the dead target does not require proving the
   return delta first — but the replacement level must be justified structurally
   (reachability against the realized MFE distribution), **not** selected by
   picking the best-performing policy from this table. Selecting `wide` because
   it topped both markets here would be choosing on a t=1.35.

## Reproduce

All queries are read-only. `atr_exit_outcomes` is written by nightly label
maturation and is not modified by this analysis.

```sql
-- Date-clustered paired delta, live vs each predeclared ATR policy (h10).
WITH live AS (
  SELECT t.market, o.id AS obs_id, o.ts::date AS d, t.realized_pnl_pct/100.0 AS live_ret
  FROM paper_trades t JOIN decision_observations o ON o.signal_id = t.signal_id
  WHERE t.closed_at IS NOT NULL
),
cf AS (
  SELECT live.market, live.d, x->>'policyId' AS policy_id,
         (x->>'netReturn')::numeric - live.live_ret AS delta
  FROM live
  JOIN observation_labels l ON l.observation_id = live.obs_id AND l.horizon_days = 10
  CROSS JOIN LATERAL jsonb_array_elements(l.atr_exit_outcomes) AS x
  WHERE l.atr_exit_outcomes IS NOT NULL
),
per_date AS (
  SELECT market, policy_id, d, AVG(delta)*100 AS mean_delta_pp
  FROM cf GROUP BY market, policy_id, d
)
SELECT market, policy_id, COUNT(*) AS dates,
       ROUND(AVG(mean_delta_pp)::numeric,2) AS delta_pp,
       ROUND((AVG(mean_delta_pp)/NULLIF(STDDEV_SAMP(mean_delta_pp)/SQRT(COUNT(*)),0))::numeric,2) AS clustered_t
FROM per_date GROUP BY market, policy_id ORDER BY market, delta_pp DESC;
```

```sql
-- +20% target reachability against realized MFE.
SELECT o.market, l.horizon_days AS h, COUNT(*) AS n,
       ROUND(AVG(l.max_favorable_excursion*100)::numeric,2) AS avg_mfe_pct,
       ROUND((PERCENTILE_CONT(0.90) WITHIN GROUP
              (ORDER BY l.max_favorable_excursion*100))::numeric,2) AS p90_mfe_pct,
       ROUND(100.0*COUNT(*) FILTER (WHERE l.max_favorable_excursion >= 0.20)
             /COUNT(*),1) AS pct_reaching_target
FROM decision_observations o
JOIN observation_labels l ON l.observation_id = o.id
WHERE l.horizon_days IN (10,20)
GROUP BY o.market, l.horizon_days ORDER BY o.market, h;
```

## Re-run trigger

Re-run when either market reaches **n ≥ 120 closed trades with h10 labels**
(`nEffective ≥ 12`). At the current rate that is several months out. The h60/h120
horizons added 2026-08-17 will extend this table without needing a rebuild.
