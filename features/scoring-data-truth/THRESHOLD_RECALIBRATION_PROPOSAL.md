# Proposal: Score Threshold Recalibration

## Status

Architecture status: Reviewed and rejected in current form (2026-07-31)

Architecture approved: No

Implementation allowed: No

No score threshold or trading configuration changed during this review.

## Review correction: the proposal read the wrong control plane

Production has two threshold-shaped values:

| Source | Value | Authority |
|---|---:|---|
| `strategy_config.score_threshold` | 52 | Legacy global risk-profile value; not the current market-local entry authority |
| `trading_mandates.score_threshold` | US 60 / India 60 | Current ResearchAgent, PaperTrader, PositionMonitor, Router cohort, and AutonomousLive authority |

The original 21-day counts were computed at **60**, not 52. In the frozen cohort,
`640 / 1,461 = 43.8%` was the US score-at-least-60 rate. A refreshed production
query showed that score-at-least-52 would instead pass 64.4% in the US and 92.1%
in India. The proposal attached a useful distribution count to the wrong field and
incorrectly described 52 as the owner's active choice.

This is load-bearing. Writing `strategy_config` would not recalibrate the active
market-local gate. Silently writing `trading_mandates` would change a contract the
original proposal did not identify.

## Evidence that is available

The original review found 8 completed US trade rows and 50 India rows. A direct
production recheck later on 2026-07-31 found 20 US and 50 India rows. That is still not
enough to fit a threshold. However, saying outcome evidence is impossible was too
broad. The immutable observation ledger already contains matured forward returns:

| Market | h2 | h5 | h10 |
|---|---:|---:|---:|
| US | 536 labels / 14 as-of dates | 338 / 11 | 74 / 7 |
| India | 151 / 13 | 130 / 12 | 65 / 7 |

These labels support diagnostics, not a decision-grade threshold optimization.
They repeat symbols inside a small number of cross-sections, most observations use
the pre-fix scorer, and only 7-14 independent dates exist per horizon. One filled
US live BUY and zero live SELLs add no calibration power.

## What the data-truth correction changed

At the unchanged authoritative threshold of 60, the one-off corrected-score
reconstruction estimated:

| Market | n (21d) | Old pass | Estimated corrected pass | Old rate | Corrected rate |
|---|---:|---:|---:|---:|---:|
| US | 1,461 | 640 | 741 | 43.8% | 50.7% |
| India | 368 | 274 | 284 | 74.5% | 77.2% |

The distribution moved because the audit removed a 68% silent P/E default,
invalid-P/E penalties, and an ordinary-weak-close hard veto. Those defects did not
express risk preference. But the old 43.8% rate was also not an explicit product
decision; it was an incidental output of a default threshold applied to a
corrupted scorer. Quantile matching can reproduce that statistic, but cannot show
that it is desirable.

## Options

### Option A: quantile-match the old pass rate

Not recommended now. It would preserve an artifact without outcome evidence. A
future owner-approved version would need a reusable read-only reconstruction, full
per-market score distributions, frozen flip tables, and an explicit decision about
the target admission rate. Any write belongs in market-local `trading_mandates`,
not the legacy global field.

### Option B: keep the active threshold at 60

Recommended as a no-change observation period.

- The counterfactual adds 101 US score passes over 21 days, about 4.8 gross
  candidates per day before direction and downstream gates.
- The first review found 15 US names against a cap of 15. A later production
  recheck found 10 open US names, leaving five slots. That makes admission risk
  relevant again, but it does not make candidate supply scarce.
- The first post-fix US day produced 60 eligible long signals out of 135. The
  earnings repricing barrier separately neutralized two high-scoring stale AAPL
  holding reassessments. Candidate supply is not currently scarce.
- Keeping 60 avoids changing scorer inputs and risk posture in the same evidence
  window. It does not claim that 60 is optimal.

### Option C: outcome-optimize the threshold

Not decision-grade yet. Use matured labels diagnostically, but do not fit a cutoff
until there are enough independent post-fix market dates, meaningful exit turnover,
and a predeclared objective that includes return, drawdown, turnover, and costs.

## India is a separate problem

India passed 74.5% at the real threshold of 60 before the correction and an
estimated 77.2% after it. A gate admitting roughly three names in four may mean the
India scorer lacks discrimination under its smaller availability set. Do not
preserve that rate by quantile and do not copy a US threshold. Diagnose India with
its own post-fix score distribution, forward labels, and entry/exit capacity.

## Recommendation

Keep both market-local thresholds at 60. Revisit US after at least 20 post-fix
market sessions and meaningful exit turnover. Revisit India as a separate scorer
discrimination study. The 15-name cap and downstream portfolio gates remain the
capital-deployment controls during this observation period.

`strategy_config.score_threshold` is legacy ambiguity. Removing or aliasing it is
a separate schema/contract proposal because older UI and backtest surfaces may
still read it; do not silently synchronize the two fields.
