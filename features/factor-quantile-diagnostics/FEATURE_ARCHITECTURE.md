# Factor quantile + stability diagnostics (alphalens method port)

> Status: **DRAFT — awaiting approval.** No code written.
> Created: 2026-09-02
> Scope: `lib/learning/dimension-diagnostics.ts` and the Learning-page panel.
> Measure-only — nothing here can reach a score, size, entry, exit or order.
> Source of method: [alphalens-reloaded](https://github.com/stefan-jansen/alphalens-reloaded)
> (Apache-2.0, 642★). Method is ported; no dependency is added.

## 1. Why, in one line

Rank IC answers *"does the ordering correlate with returns?"*. It cannot answer
*"is the ordering monotonic, and is the top-minus-bottom spread worth trading?"* —
and those are the questions that decide whether a dimension is real.

## 2. What we already have vs what alphalens computes

| alphalens function | Kairos today | Gap |
|---|---|---|
| `factor_information_coefficient` | per-session Spearman rank IC | — |
| `mean_information_coefficient` | `mean_session_rank_ic` | — |
| IC by date (series) | `session_ic_series` (2026-09-02) | — |
| **`mean_return_by_quantile`** | **nothing** | **monotonicity unknown** |
| **`compute_mean_returns_spread`** | **nothing** | **no tradeable magnitude, no SE** |
| **`factor_rank_autocorrelation`** | **nothing** | **stability unknown** |
| `quantile_turnover` | nothing | low priority — we do not trade a factor portfolio |

## 3. The three measures to add

### 3.1 `mean_return_by_quantile`

Per session, bucket the cross-section into quintiles by the dimension's score and
take each bucket's mean benchmark-neutral forward return. Average per bucket
across sessions.

**Why it matters here.** A small positive IC is consistent with two very
different worlds: a clean monotonic gradient (Q1 < Q2 < Q3 < Q4 < Q5), or a flat
middle with one extreme tail dragging the correlation. The first is tradeable;
the second is an artifact. Sentiment's `+0.0886` and technical's `-0.1325` are
currently indistinguishable between those cases.

### 3.2 `compute_mean_returns_spread` (top minus bottom, with standard error)

Q5 − Q1 per session, then mean and standard error across sessions.

**Why it matters here.** This is the only number in the whole diagnostic that is
denominated in *returns* rather than correlation units — the answer to "how much
is this dimension worth". Its standard error also yields significance directly,
using the same `nEffective` overlap correction already applied to IC, without
inventing a second statistical convention.

### 3.3 `factor_rank_autocorrelation`

Correlation between a dimension's cross-sectional ranks on consecutive sessions.

**Why it matters here, specifically.** It would have diagnosed `macro` on sight:
a market-wide scalar has an undefined/degenerate rank autocorrelation because it
has no cross-sectional variance at all — the same fact that makes its IC `0.0000`
by construction. More usefully it separates two failure modes we cannot currently
tell apart for `technical`: a stable signal that is genuinely inverted (autocorr
high, IC negative — actionable, flip or drop it) versus a signal whose ranking is
noise from day to day (autocorr near zero — a data problem, not an alpha problem).

## 4. Constraints this must respect

1. **Cohort.** Headline on eligible-long (`lib/learning/entry-cohort.ts`),
   all-scored as labelled context. Same rule as every other predictive finding.
2. **Floors.** `MIN_PREDICTIVE_DATES` 20 and `MIN_EFFECTIVE_OBSERVATIONS` 12 still
   gate any verdict. Quantiles need their own floor: a session contributes only if
   every bucket has a minimum membership (proposed: 3), because a quintile built
   from one name is not a quintile. Sessions below it are excluded and counted,
   never silently folded in.
3. **No migration.** These live in the existing `metrics` jsonb beside
   `session_ic_series`, immutable with their finding.
4. **No plan-version bump.** `mean_session_rank_ic` is unchanged; the fields are
   additive. Same reasoning as the 2026-09-02 series addition — and the same
   check: the existing numbers must come back byte-identical.

## 5. The caveat that must ship WITH the numbers

Quantiles on the eligible-long cohort are computed on a distribution **truncated
at the entry threshold** — everything below `analyst_score >= 60` is already gone.
So "Q1" there is not the factor's true bottom quintile; it is the bottom of the
survivors. The top-minus-bottom spread on that cohort therefore understates a
factor's full range and is **not** comparable to a published alphalens tear sheet.

Both cohorts get computed for exactly this reason, and the panel must label which
is which — the same collider problem measured on 2026-09-02, where component ICs
roughly halved between the eligible and all-scored cohorts.

## 6. Deliberately NOT in scope

- `quantile_turnover`, `factor_weights`, `factor_returns`, `factor_alpha_beta`,
  `factor_cumulative_positions`: these describe a portfolio built FROM a factor.
  Kairos does not trade single-dimension portfolios; the composite plus the entry
  gate decides. Building them would measure a strategy that does not exist.
- Any alphalens dependency. It is Python; the money path is TypeScript on
  serverless. The method ports; the library does not.
- Any change to weights, thresholds or eligibility. Measure-only.

## 7. Expected outcome, stated in advance

Most dimensions will read `insufficient_evidence` — 29 qualifying sessions at h5
is `nEffective` 5.8 against a floor of 12, and adding measures does not add
evidence. Predeclaring that matters: the value here is that a *future* verdict is
better-founded, not that today's numbers change. If a monotonic quantile gradient
appears alongside a sub-floor IC, that is still not permission to act.

## 8. Size

One module change (`dimension-diagnostics.ts`), one panel section, tests. No
migration, no new dependency, no new route, no schedule change.
