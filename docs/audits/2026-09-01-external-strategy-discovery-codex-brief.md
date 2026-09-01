# Codex review brief — external strategy discovery (2026-09-01)

Adversarial review requested on an architecture proposal. **No code has been
written and nothing is activated.**

Document under review:
`features/external-strategy-discovery/FEATURE_ARCHITECTURE.md`

It incorporates your 2026-09-01 response and supersedes
`features/strategy-library-shadow/FEATURE_ARCHITECTURE.md` from the same day.

**Assume every claim below may be wrong.** The author's recent record on this
codebase includes five claims that did not survive verification, listed at the
end. Verify against the repo and the database rather than trusting the prose.

---

## What changed because of your last review

Accepted and incorporated:

- **The legal boundary**, which the earlier draft missed entirely. Metadata only;
  independently written rule specs with attribution; never article text, charts,
  paid rules or their code; exclude `/shop`, `/member`, `/amember`; rate-limit;
  prefer written permission. Crawler as local research tool, never a production
  dependency.
- **Deflated Sharpe Ratio and Harvey-Liu-Zhu** as the multiple-testing frame,
  replacing a Sidak-only treatment.
- **The six-strategy first trial family**, with next-open execution for
  Turnaround Tuesday because the source article admits the close-entry look-ahead.
- **The combination design**: four portfolios per pair with `champion + A + B` as
  the real decision; parallel sleeves / confirmation / frozen regime routing;
  complementarity report including correlation on losing and high-volatility
  days; exact Shapley attribution given <=3 constituents.
- **Recommend-only authority.** The app may never activate a strategy.

Added independently, and needing your scrutiny:

- **Stage 0** (see disagreement below).
- **Section 8b** — per-symbol strategy switching over time, after the owner asked
  for it mid-review.

---

## THE DISAGREEMENT TO RESOLVE

You recommended starting with a metadata-only catalogue and the six-strategy
trial family.

The author inserted a **Stage 0** before that, on the grounds that the foundation
you cited is thinner than it appears. Verified against production 2026-09-01:

| component | state |
|---|---|
| `lib/simulation/portfolio-simulator.ts` | real, tested |
| `lib/validation/` (8 modules) | real |
| `strategy_templates` / `strategy_sleeves` | 7 rows each |
| `backtest_experiments` | 18 rows |
| **`strategy_evaluations`** | **0 rows — never produced an evaluation** |
| **`strategy_template_shadow_configs`** | **`to_regclass` returns NULL — migration file exists but is untracked and was never applied** |
| `features/strategy-portfolio-lab` | untracked draft, not in git |
| `features/portfolio-simulation` | untracked draft, not in git |

**Please re-verify all eight rows independently**, then rule on the sequencing:

- **(a)** Stage 0 first — prove the existing pipeline writes one real
  `strategy_evaluations` row, land the untracked drafts, apply and verify the
  missing table — before building discovery on top of it.
- **(b)** Your original order — catalogue and trial family first, fixing the
  pipeline as it is exercised.
- **(c)** Something else: e.g. the existing pipeline is unproven enough that a
  minimal purpose-built replay harness is *safer* than extending it, despite the
  "don't build a second backtester" rule.

The author's position is (a), with low confidence. The argument for (b) is that
Stage 0 could absorb weeks on machinery that discovery may not need in the shape
it currently has. Argue whichever you believe.

---

## Claims to verify

### C1 — Legal boundary

Is the reading of `robots.txt` plus the copyright policy correct, and are the
resulting constraints right — or is the proposal **over**-constrained (blocking
legitimate fair use) or **under**-constrained (still reproducing protected
expression through "independently written" specs that are in practice
paraphrases)? Where exactly is the line between a rule as unprotectable idea and
an article as protected expression?

### C2 — Calendar rules as exposure overlays, not selection inputs

Claim: Turnaround Tuesday, Turn of the Month and Santa Claus Rally emit the same
signal for every symbol on a date, so they carry **zero cross-sectional rank
information** and must be evaluated as market-timing overlays.

Supporting production measurement: `macro_score` was constant within **49 of 49**
US dates, yet still moved rankings because per-row availability-mask
renormalisation varied its effective weight from 0% to 42.86%.

**Verify the analogy holds.** If a constant-per-date signal can still shift a
composite through weight renormalisation, does that undermine the claim that
calendar rules carry zero rank information — or does it strengthen the argument
for keeping them out of the composite entirely?

### C3 — The six-strategy family

Are these the right six for a first frozen family, given an EOD long-only book on
a 2-20 market-day swing mandate? Which would you swap and why? Is anything in the
list unreplayable with data we actually hold point-in-time?

### C4 — Combination design

- Is `champion + A + B` the right decision object, or should it be
  `champion + A` vs `champion + B` vs `champion + A + B`?
- Is exact Shapley attribution over <=8 subsets genuinely deterministic here, or
  does path dependence in the simulator (capital reuse, fill ordering) break
  additivity?
- Is "one active combination challenger per market" too strict to ever learn
  anything, or correctly strict?

### C5 — Per-instrument shrinkage (section 8)

The proposal uses hierarchical shrinkage toward a global per-strategy effect,
with instrument-CLASS grouping preferred over per-symbol.

Is empirical Bayes / James-Stein the right instrument here, or is class-level
grouping alone sufficient and simpler? Is `lib/scoring/instrument-taxonomy.ts`
an adequate grouping key — check what it actually classifies before answering.

### C6 — Per-symbol strategy SWITCHING (section 8b) — attack this hardest

The owner asked whether symbols move between strategies over time and whether the
app could detect that and switch.

The proposal declines to build a switcher and instead specifies a **premise test**:
rank the six strategies per symbol in period *t*, rank again out-of-sample in
*t+1*, measure the date-clustered rank correlation of strategy affinity, and
compare against a label-permuted null (reusing the seeded placebo machinery in
`lib/analytics/alpha-diagnostics-counterfactual.ts`, `(b+1)/(m+1)` estimator).
Predeclared rule: indistinguishable from null → stop and close the question.

Please attack:

1. **Is the statistic right?** Is rank correlation of per-symbol strategy affinity
   between adjacent periods the correct test of persistence, or is there a
   better-specified one (transition-matrix stationarity, HMM state persistence,
   a direct out-of-sample "trade last period's best" backtest)?
2. **Purge and embargo.** Adjacent periods share overlapping forward windows. Does
   the test need purging, and if so how much?
3. **Power.** With ~26 independent h10 dates today, is this test answerable at all
   yet, or does it need its own accrual period? If unanswerable now, say so —
   proposing a test that cannot report is its own failure mode.
4. **Is declining to build the switcher correct?** `CLAUDE.md` carries a locked
   decision to push back on explicit regime switching as "fragile and adds moving
   parts". Is per-symbol switching genuinely that same machinery, or a materially
   different thing the locked decision does not cover?

### C7 — What is missing

Name anything absent that would matter: survivorship handling in replay,
corporate actions, the India path, cost model realism, how a retired strategy is
recorded, how the trial-family count is persisted and audited across sessions so
it cannot silently reset.

---

## Context you need

- **Cohort discipline**: `lib/learning/entry-cohort.ts` — predictive claims are
  made on `entry_eligible = true AND direction = 'long'` only. All-scored figures
  are context. Three published claims were retracted 2026-08-28 for violating it.
- **Evidence floors**: `MIN_PREDICTIVE_DATES = 20`, `MIN_EFFECTIVE_OBSERVATIONS = 12`
  (overlap-adjusted, `nDates / horizonDays`), `MIN_REVIEW_DATES = 60`.
- **Current data**: 26 independent h10 dates per market = **2.6** effective
  observations. US eligible-long h10 rank IC **-0.0768**, India **-0.0083**.
- **Frozen-history rule**: annotate, never re-decide. A changed metric gets a new
  plan/genome version.
- **Multiplicity precedent**: `lib/trading/exit-stop-shadow.ts` stores
  `trials_considered` and `sidak_alpha` on every row so a nominal p-value cannot
  be mistaken for the adjusted threshold. Reuse that pattern.
- **Existing placebo machinery**: `lib/analytics/alpha-diagnostics-counterfactual.ts`.
- **Point-in-time universe**: `lib/edges/pit-universe.ts` exists, fails closed,
  and is currently wired only into the OOS orchestrator — `app/api/agents/edge-ic`
  still uses the survivorship-biased curated list. Relevant if replay needs PIT
  membership.

---

## The author's recent error record, for calibration

Five claims that failed verification in the past week, all the same shape — a
confident conclusion from the wrong population or an unread code path:

1. "Rotation has never moved capital" — false; it had executed swaps.
2. "India's largest positions lose money" — closed lots only; 8 of 14 open
   positions were in the largest quartile and reversed the sign.
3. "India's score ranks forward returns, +0.105" — all-scored cohort; the
   eligible-entry cohort is -0.008.
4. "macro_score comes from LLM general knowledge" — read from dead code; the live
   path is deterministic and well-guarded.
5. "The F2 replay is exact" — it was an approximation that disagreed numerically
   with a real code replay on 4,573 of 5,242 rows.

Treat the prose accordingly. Production and the code are the authorities.

---

## What a good review returns

- A ruling on the **sequencing disagreement** (a / b / c), with reasoning.
- A verdict per claim C1-C7: confirmed / partially wrong / wrong, with the query
  or `file:line` that settles it.
- Any component cited as foundation that does not exist or does not work.
- If you would architect the funnel differently, say so and describe it.
- An explicit statement of what should be built **first**, in what order, and
  what should not be built at all.
