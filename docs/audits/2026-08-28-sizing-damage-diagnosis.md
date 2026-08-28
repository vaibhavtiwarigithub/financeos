# Why India's selection edge does not reach the P&L

Frozen diagnosis, 2026-08-28. Evidence only — **no sizing behaviour was
changed**. Any change to position sizing is a money-path decision and needs its
own approval.

Triggered by the Alpha Diagnostic Lab A3 finding: India percentage profit factor
**1.438** against a currency profit factor of **0.906**. The picks are
profitable; the capital allocated to them is not.

## 1. The damage is real and monotonic

India closed lots, clean cohort, by entry-notional quartile:

| quartile | lots | mean notional | mean return | currency P&L | win rate |
|---|---|---|---|---|---|
| 1 (smallest) | 25 | ₹5,726 | **+3.49%** | **+5,871** | **60%** |
| 2 | 25 | ₹13,908 | -0.79% | -2,822 | 56% |
| 3 | 24 | ₹27,785 | +0.39% | +2,437 | 54% |
| 4 (largest) | 24 | ₹66,159 | **-0.55%** | **-10,113** | **38%** |

Win rate falls monotonically 60 → 56 → 54 → **38%** as size rises. The smallest
quartile earns +5,871; the largest loses -10,113.

## 2. Size is not driven by conviction

| relationship | correlation | n |
|---|---|---|
| notional vs **cash available at entry** | **+0.344** | 98 |
| notional vs entry time | -0.233 | 98 |
| notional vs **analyst_score** | **-0.128** | 98 |
| notional vs fill price | +0.003 | 98 |

Notional spans ₹2,124 to ₹120,655 — a **57x** spread on a book whose sizing is
nominally uniform. Mean score by size quartile is flat and unordered (86.6,
82.6, 88.2, 81.1).

**Position size is a function of how much cash happened to be free when the
candidate arrived**, not of how good the candidate was. Early entries into a
near-empty book take large allocations; later entries take the residual, which
is why size also declines with time (-0.233).

## 3. Why that specifically destroys India

India's score **does** rank forward returns: h10 date-clustered rank IC
**+0.105** (t 2.24), independently reproduced twice through different code
paths. So the selection carries a real, if small, edge.

But allocation is uncorrelated with that edge. Good picks routinely receive
small allocations and weak picks large ones, by accident of timing. Averaging
returns equally shows the edge (percent PF 1.438); weighting by the capital
actually deployed destroys it (currency PF 0.906).

This is the precise failure mode A3 reports both profit factors to expose.

## 4. The volatility budget is a separate, real defect — and NOT the cause

`portfolio-constructor` Rule 4 scales candidates down when estimated portfolio
daily vol exceeds `maxPortfolioVolPct = 2.0`. It has fired **zero** times across
1,513 constructor events in 60 days.

The cap is mathematically unreachable at the default per-symbol vol
(`DEFAULT_DAILY_VOL = 0.02`). Reproducing `estPortfolioVol` exactly:

| names | gross | pairwise corr | est. portfolio vol |
|---|---|---|---|
| 5 | 100% | 0.6 (all same sector) | **1.649%** |
| 10 | 100% | 0.3 | 1.217% |
| 15 | 80% | 0.3 | 0.942% |

**1.65% is the worst case across every configuration** — concentrated, fully
invested, single-sector. The cap is 2.0%. Breaching it requires per-symbol vol
>= ~0.035 (3.5% daily, ~55% annualised), which a normal large-cap book never
reaches. The rule is not broken code; the threshold is set above what the model
can produce.

Fixing it would not fix section 1. Volatility is not what is mis-sizing this
book — cash-path dependence is.

## 5. Confidence and limits

- 98 India lots. Correlations of +0.344 and -0.128 are modest and this is a
  single market over roughly seven weeks.
- The quartile win-rate gradient (60 → 38%) is the strongest part of the
  evidence; the correlation decomposition is supporting, not conclusive.
- US is NOT the same problem. Its percent PF is 0.969 and currency PF 0.735 —
  both below 1, and its rank IC is -0.012 with a negative quintile spread. The
  US selection does not rank at all, so sizing is not its binding constraint.
- Nothing here establishes that a specific alternative sizing rule would do
  better. A5's equal-notional counterfactual is the instrument for that and has
  not been run as a paired comparison over a long enough calendar.

## 6. What this does NOT license

- Changing `position_size_pct`, `maxPortfolioVolPct`, or the allocation formula.
- Concluding that conviction-weighted sizing would be better; that is a
  hypothesis this diagnosis motivates, not a result it proves.
- Any inference about the US book from India's numbers.
