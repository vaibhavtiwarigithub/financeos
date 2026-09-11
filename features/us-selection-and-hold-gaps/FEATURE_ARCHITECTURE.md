# US Selection Gap + Indefinite-Hold Gap

> Status: **STAGE 0 MEASURED; STAGES 1–2 NOT APPROVED.** No score, weight, exit,
> sizing, paper or live change is authorized by this document.
> Last revised: 2026-09-11.
> Money-path influence: **none** until Stage 2 is separately approved.

Two gaps opened by the 2026-09-11 Codex audit. They are unrelated in mechanism
and very different in size, so they are staged separately.

## Stage 0 correction — the originally claimed mechanism is not established

Codex independently replayed every mature h2/h5/h10/h20 label on 2026-09-11,
using the production cohort (`entry_eligible=true AND direction='long'`) and
the same minimum five-name cross-section. The original IC direction reproduced,
but its significance did not. The quoted t-statistics treated consecutive,
overlapping 10-day return windows as independent observations. The app's own
predeclared diagnostic contract uses `nEffective = sessions / horizonDays`.

| market | horizon | technical rank IC | sessions | nEffective | overlap-adjusted t |
|---|---:|---:|---:|---:|---:|
| US | 2 | -0.0045 | 34 | 17.0 | -0.06 |
| US | 5 | -0.1302 | 39 | 7.8 | -1.55 |
| US | 10 | -0.1993 | 29 | 2.9 | -1.56 |
| US | 20 | -0.2762 | 23 | 1.15 | -1.51 |
| India | 2 | -0.0016 | 28 | 14.0 | -0.02 |
| India | 5 | +0.0390 | 27 | 5.4 | +0.31 |
| India | 10 | +0.1770 | 22 | 2.2 | +0.97 |
| India | 20 | +0.0966 | 13 | 0.65 | +0.42 |

The US pattern is horizon-shaped — neutral at h2, increasingly negative by
h5/h10/h20 — and the h10 negative ordering is concentrated in RSI (-0.219),
price-vs-EMA50 (-0.256), and 20-day trend (-0.187), not volume (-0.014).
That is consistent with medium-horizon mean reversion, but it is not yet causal
or promotion-grade.

More importantly, **1,134/1,374 (82.5%) of the US h10 cohort rows came from
`discovery_source='holding'`**. Within the much smaller watchlist slice,
technical IC was +0.046 across only 10 sessions. The original text jumped from
a mostly post-entry holding cohort to “PaperTrader selects the worst names.”
That attribution is invalid. The same-session traded-vs-control gap remains a
separate concern, but this replay does not prove technical weight caused it.

Therefore the earlier `t=-5.42`, BH-survival, “root cause located,” and
“stable across both months” conclusions below are retained only as provenance
of the superseded analysis. They must not justify a weight, sign, entry, exit,
paper, or live change. Stage 1 should not start until an entry-time-only cohort
has enough non-overlapping evidence and isolates holdings from candidates.

The same caveat applies to the claimed traded-vs-control significance. Pairing
on date removes the common benchmark window; it does **not** make adjacent h10
forward windows independent. Fifteen daily starts are approximately 1.5
non-overlapping h10 observations under the repository's predeclared rule. The
reported `t=-3.26` would scale to about `-1.03`, before any small-sample or
multiple-testing penalty. Keep the -3.45pp difference as descriptive monitoring,
not as a statistically established selection defect.

---

## Gap 1 — US selection appears worse than its own eligible set; significance unproven

### Measured (production, h10 benchmark-neutral labels)

Traded US names versus entry-eligible names scored on the SAME session, so the
market window cancels by construction:

| | value |
|---|---|
| traded mean | -3.88% |
| control mean | -0.44% |
| **difference** | **-3.45pp** |
| overlapping daily starts | 15 |
| naïve date t | -3.26 |
| approximate effective h10 windows | 1.5 |
| overlap-adjusted t | about -1.03 |

This is a useful same-session control, but the original conclusion was too
strong. Same-session pairing removes the shared benchmark return; it does not
remove serial dependence between adjacent ten-session outcomes.

### Superseded mechanism claim: composite anti-predictive, driven by one dimension

Session-level rank IC against h10 benchmark-neutral return, Benjamini-Hochberg
over the 6 dimension-market tests (alpha 0.05). Three survive:

| market | dimension | rank IC | t | sessions | survives BH |
|---|---|---|---|---|---|
| **US** | **technical** | **-0.2208** | **-5.42** | 28 | yes |
| India | fundamental | -0.1533 | -3.30 | 18 | yes |
| US | sentiment | +0.1117 | +3.08 | 29 | yes |
| India | technical | +0.0968 | +2.10 | 18 | no |
| US | fundamental | +0.0840 | +1.67 | 28 | no |
| US | insider | +0.0194 | +0.42 | 26 | no |

Composite rank IC: US **-0.0942 (t=-2.23)**, India -0.0905 (t=-1.67, n.s.).

**US technical is stable across both available months** — July -0.2127 (18
sessions), August -0.2333 (11 sessions). Not a single-window artifact.

### Superseded causal attribution — not established

`strategy_config.risk_profile` is `aggressive`, whose weights are
`fundamental 0.20, technical 0.30, sentiment 0.25, macro 0.15, insider 0.10`.
**Technical carries the LARGEST weight.** PaperTrader buys the highest-composite
eligible names, the composite is dominated by a dimension that is inverted in
US, so it systematically selects the worst of its own eligible set.

Both markets share ONE global `risk_profile`, yet technical has OPPOSITE signs
by market (US -0.22, India +0.10). One weight vector cannot be correct for both.
Per-market weights exist in the champion genome, but both champions carry
`genome->'weights' = null`, so both fall back to the same global profile.

### Leading hypothesis for the inversion — test before acting

`CLAUDE.md` locks the momentum bucket as `RSI > 60, price > 50-day MA`. Buying
short-term-overbought US names and measuring at h10 is a mean-reversion window:
high-RSI names give back over 2-3 weeks. That would produce exactly a negative
technical IC at h10 while the same signal could be positive at h2 or h60.

**This is a hypothesis, not a finding.** It must be tested by computing the
technical IC across h2/h5/h10/h20 separately per market before any weight
changes. If the IC is horizon-dependent rather than simply wrong, the fix is the
horizon or the feature definition, NOT the weight.

### Explicit non-goals

- **Do NOT flip the sign of the technical dimension.** An inverted feature fit
  to 28 sessions is curve-fitting, and the sign disagrees across markets.
- Do not change the composite weights directly from this document.
- Do not tune on realized P&L. The Scoring Data-Truth Protocol requires a
  frozen, read-only counterfactual first.

### Staging

**Stage 0 — complete, but mechanism remains unresolved (read-only).**
Technical IC by horizon (h2/h5/h10/h20), sub-feature decomposition, discovery
source and instrument-family concentration were measured. No defensible
entry-selection mechanism was found: the horizon shape is descriptive and the
dominant holding cohort invalidates the original entry-causality claim.

**Stage 1 — per-market weights as a shadow.**
Populate per-market champion genome weights and run them as a shadow arm against
the incumbent global profile. Report composite IC, selection delta versus
same-session eligible controls, and matured h10/h20 outcomes, US and India
separately. A neutralized US technical weight is ONE predeclared arm; it is not
the assumed answer.

**Stage 2 — separately proposed promotion.**
Only with matured labels and a frozen counterfactual naming which historical
decisions flip, per market, with a rollback path (the global profile stays the
fallback).

### Interim posture

US autonomous live stays OFF. This is direct evidence the US selector is
negative against its own eligible set; arming it would trade a measured
disadvantage. India is unaffected by this specific finding — its composite IC is
not significant, and its own flagged dimension is fundamental, not technical.

---

## Gap 2 — a position that never trades above entry never ratchets

### The defect

Decision 74 removed the time stop and claimed "nothing is held indefinitely"
because a stalled position rides its ratcheting trail. **That claim was false and
is withdrawn.** The trail is anchored to `highest_price`. A position whose price
never exceeds entry never advances it, so the stop stays at the entry-day level.

### Measured size — small and self-limiting

Share of entry-eligible observations whose max favorable excursion never exceeds
zero, by horizon:

| horizon | US | India |
|---|---|---|
| 2d | 25.3% | 18.0% |
| 5d | 12.7% | 13.5% |
| 10d | 8.1% | 9.8% |
| 20d | 4.1% | 5.9% |

Of the h20 never-above-entry cohort, the existing 7% initial stop still catches
most: **US 66/85 (77.6%)**, **India 20/31 (64.5%)**. The genuinely stuck
population — no new high AND never reaching the stop — is:

- **US 19 of 2080 = 0.91%**
- **India 11 of 524 = 2.10%**

Current open book: 7 of 27 positions have `highest_price = entry` exactly, all
0-4 days old, and 6 of 7 still score >= 70. One (TCS.NS, score 56) will
score-exit.

### Recommendation: instrument it, do not build an exit rule yet

At ~1-2% of positions, a new exit mechanism is not worth its risk surface, and
any calendar-shaped rule is explicitly rejected by Decision 74. Proposed instead:

1. A health alert when an open position exceeds N sessions with
   `highest_price <= avg_cost` AND a score still above the exit threshold. Pure
   observability, no money path, and it is the evidence source for a future rule.
2. Revisit after 30 days of no-time-stop operation with real hold-duration data.
   Holds only started lengthening on 2026-09-10; today's max hold is 11 days, so
   there is not yet any evidence of the failure mode actually biting.

### Separate defect found while measuring this

`paper_trades.highest_price` is **NULL on all 213 closed rows** as of the
2026-09-11 verification — the column is
never written at close, though `paper_positions.highest_price` is maintained
while open. Any analysis joining trail behaviour to closed outcomes is silently
empty. This is a data-capture bug, not a trading bug, and should be fixed before
the Gap 2 evidence above can be reproduced from trades rather than labels.
