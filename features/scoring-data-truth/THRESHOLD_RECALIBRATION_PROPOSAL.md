# Proposal: Score Threshold Recalibration

## Status

Architecture status: Draft
Architecture approved: No
Implementation allowed: No

Follows proposal #2 in `CODEX_SCORING_DATA_TRUTH_AUDIT_RESULT.md`.

## The trap in the word "calibration"

"Threshold calibration" normally means *find the cutoff that maximises outcome*.
That requires knowing how score relates to forward return — which is exactly what
this codebase has already proven it cannot measure at its current scale
(`features/walk-forward-ic-folds` Annex K: realized IC sigma ~0.26, effective
breadth ~17 names, ~180 as-of dates required against ~25 available).

Measured 2026-07-31, matured closed trades available to fit against:

| Market | Closed trades |
|---|---|
| US | **8** |
| India | 50 |

**Any threshold fitted to 8 outcomes is overfitting**, and would be a worse
decision procedure than the arbitrary constant it replaced. This proposal
therefore does **not** attempt outcome-based calibration, and recommends that it
not be attempted until the outcome record is an order of magnitude larger.

## The question that IS answerable

The `df479bdc` data-truth fixes corrected the score inputs. They did not change
`score_threshold`, which stayed at **52**. So the distribution moved and the
cutoff did not:

| Market | n (21d) | Old pass | New pass | Old selectivity | New selectivity |
|---|---:|---:|---:|---:|---:|
| US | 1,461 | 640 | 741 | **43.8%** | **50.7%** |
| India | 368 | 274 | 284 | 74.5% | 77.2% |

The owner chose 52 against the *old* distribution. The distribution then shifted
for reasons unrelated to the owner's risk preference — a 68% silent P/E default,
invalid P/E penalties, and a spurious hard veto were removed. **The resulting
~16% wider US gate is a side effect, not a decision.**

So the answerable question is not "what threshold is optimal" but:

> What threshold reproduces the selectivity the owner actually chose, under the
> corrected distribution?

That is quantile matching. It needs **no outcome data** and makes **no alpha
claim** — the same epistemic category as the earnings-risk work.

## Options

### Option A — Quantile-match to restore intended selectivity (recommended)

Find `t_us` such that the corrected scorer passes 43.8% of US signals, and
`t_india` for 74.5%. Preserves the owner's revealed selectivity while keeping the
input fixes.

- Pro: undoes an unintended loosening; no new claim; reversible; explainable.
- Con: assumes the *old* selectivity was itself sensible. It was chosen under a
  biased distribution, so it is a defensible anchor, not a proven one.

### Option B — Keep 52 and accept the loosening deliberately

Make the ~16% wider gate an explicit decision rather than a side effect.

- Pro: more entries means faster accumulation of the closed-trade record, which
  is the binding constraint on *every* validation question in this system. With
  8 US trades, evidence starvation is arguably a larger risk than mild
  over-admission.
- Con: more capital deployed sooner into a population with no outcome evidence,
  through an unvalidated composite score. `max_open_positions` is now 15 per
  market, so the practical effect is faster deployment.

### Option C — Outcome-calibrated threshold

**Not possible.** 8 US closed trades. Recorded here so it is not re-proposed
without the arithmetic being re-checked.

## What Option A needs built

The counterfactual in the audit was a one-off reconstruction; `df479bdc` left no
reusable tool. Option A requires:

1. A **read-only** reconstruction that scores historical `agent_signals` through
   the corrected scorer and emits the full score distribution per market — not
   just the pass count at one cutoff.
2. Quantile lookup for the target selectivity.
3. A frozen before/after table (threshold, pass rate, flips up/down) for owner
   review **before** any config write.
4. The threshold change itself applied as an owner-approved `strategy_config`
   edit, journaled like the India `max_open_positions` change was.

Nothing writes to `strategy_config` without a separate approval of the resulting
number.

## Caveat worth surfacing independently

India already passes **74.5%** of scored signals. A gate that admits three names
in four is barely a filter, and this is true both before and after the fixes. It
may indicate an India threshold set for a different score distribution, or a
scorer that does not discriminate on India inputs. Either way it is a separate
finding from the US loosening and should not be bundled into the same change.

## Recommendation

Adopt **Option A** for US, and treat India separately — its 74.5% pass rate is a
prior problem that quantile-matching would merely preserve.

If the owner prefers **Option B**, that is a legitimate call given how badly this
system needs closed trades. It should be recorded as a deliberate risk-posture
decision in `PROJECT_DECISIONS.md`, not left implicit.

Either way, the current state — a threshold chosen for a distribution that no
longer exists — should not be the resting position.
