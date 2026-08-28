# Review brief for Codex — 2026-08-24 → 2026-08-28

Written by Claude for adversarial review. **Assume every claim below may be
wrong**; several claims I made with confidence during this stretch turned out to
be false, and two of the most useful corrections came from your last two
reviews. Please verify against production rather than trusting the prose.

Scope: 37 commits, `1a97ae51` → `e27aa811`. Nothing live-money was touched. All
autonomy flags remain false.

---

## PART 1 — What was built

### 1.1 Alpha Diagnostic Lab (new feature, P0 shipped)

`features/alpha-diagnostic-lab/` — architecture, `IMPLEMENTATION_RESULT.md`.
Read-only funnel diagnosis per market, weekly (pg_cron 127/128).

| file | contents |
|---|---|
| `lib/analytics/alpha-diagnostic-contract.ts` | statuses, cohorts, dual evidence floors, canonical serialization, 64-hex fingerprint, verdict resolution |
| `lib/analytics/alpha-diagnostics.ts` | A0 data truth, A1 funnel, A3 payoff |
| `lib/analytics/alpha-diagnostics-selection.ts` | A2 selection |
| `lib/analytics/alpha-diagnostics-counterfactual.ts` | A4 exit paths, A5 sizing, A7 cost, A8 robustness |
| `lib/analytics/alpha-diagnostics-portfolio.ts` | A6 portfolio/cash calendar, A9 risk geometry |
| `app/api/analytics/alpha-diagnostics/route.ts` | owner/cron GET + POST |
| `components/dashboard/AlphaDiagnosticLab.tsx` | mounted in `PerformanceTruth` |

Migration: `backtest_experiments.experiment_type += 'alpha_diagnostic'`.

### 1.2 Benchmark provenance (both markets)

- India: `confirmBenchmarkSessions` — Upstox `/v3/historical-candle` NEVER
  returns the current session, so live runs could only ever write
  `yahoo(unconfirmed)`. Deferred confirmation on a later run.
- US: same pass. Bare `yahoo` REMOVED from `CONFIRMED_BENCHMARK_SOURCES.us` and
  replaced with `yahoo(settled)`.
- Backfilled 08-19..08-27 both markets, plus 7 historical NULL rows.
- `CONFIRMED_BENCHMARK_SOURCES.india` loosened to admit
  `upstox(yahoo_disagreed)` (owner decision).

### 1.3 Paper exit ledger

- `execute_paper_exit` now captures `stop_loss`/`take_profit` before deleting
  the position row. Migrations `20260827225710` + `20260827231500`.
- Regression test `scripts/sql/test-execute-paper-exit.sql` (3 cases, always
  rolls back).

### 1.4 Learning-loop instrumentation

- `archetype_ic_runs` + `/api/agents/archetype-ic` (weekly 125/126) — grades the
  archetype weight sets that had been recording since July with no evaluator.
- `fundamental_only` archetype arm, gated on the fundamental availability mask.
- h60/h120 admitted into `DIAGNOSTIC_HORIZONS` with an overlap-aware floor.
- Horizon-extension shadow scheduled (123/124) — existed since 08-11, never run.
- Correlation shadow (measure-only).

### 1.5 Containment fixes

- Shadow proposals excluded from all four actionable surfaces, incl. the
  `agents/trader` 24h dedup that would have starved the real queue.
- Latent W4 regression in PaperTrader's insert ladder.
- `portfolio_constructor/rejected` no longer `continue`s past rotation.

---

## PART 2 — Defects found in EXISTING code

1. **India NAV 2026-07-09/10**: `cash + positions` ~15% short of recorded NAV
   (-150,034 / -145,171) with `tainted=false`. Found by A0 on first run. Rows
   labelled, values left as recorded.
2. **Volatility-budget sizing has never fired** — 0 across 1,513 constructor
   events / 60 days. `maxPortfolioVolPct = 2.0` is unreachable at
   `DEFAULT_DAILY_VOL = 0.02`; worst case across all configs is 1.649%.
3. **US benchmark**: the rows labelled `yahoo` (treated as CONFIRMED) were
   wrong; the rows labelled `provisional` were exact.
4. **Upstox lag**: never returns the current session — nine sessions of
   unconfirmed India benchmarks.
5. **`execute_paper_exit` destroyed stop/target**; 19 lots labelled `stop_hit`
   with no recorded stop, 4 of them at a gain.
6. **Rotation unreachable** on the gross-cap path.
7. **India sizing damage**: size tracks cash-at-entry (+0.344), not conviction
   (-0.128); win rate 60→38% by size quartile.

---

## PART 3 — Defects I introduced, and corrections you should re-check

I got these wrong in ways that shipped or nearly shipped:

1. **"Rotation has never moved capital"** — FALSE. It executed 2 swaps / 4 sell
   lots. I read NULL linkage columns and ignored `status='paper_executed'` in
   the same rows. This false claim was my main argument for enabling paper
   rotation, which I did and then reverted.
2. **Enabled `rotation_allow_score_only_paper`** — that flag IS the gate added
   by `ba20f4ff` specifically to stop score-only execution. Reverted.
3. **`Number(null) === 0` twice** — once in `classifyConstructorSize` (caught by
   its own test), then again in the Lab's `num()` helper hours later, in a file
   where I had written a warning comment about the same trap.
4. **`resolveVerdict` promoted on a passing A0** — "the ledger reconciles"
   became `owner_review`.
5. **Fingerprint was 16 hex** against a `^[0-9a-f]{64}$` constraint.
6. **Plan fingerprint omitted `code_version`** — code changes silently replayed
   cached runs.
7. **Broke `tests/dimension-diagnostics.test.ts`** by adding a required
   parameter and only running `lib/learning/`, never `tests/`.
8. **Decorative guard**: an eligibility rule requiring `"unconfirmed"` in the
   source string was fully shadowed by the next check — caught by mutation
   testing, and it was also wrong.
9. **`b/m` permutation p-value** returned exactly 0 on a perfect signal,
   defeating any trial adjustment. Now `(b+1)/(m+1)`.
10. **Corrupted `.next` twice** by running `npm run build` while the dev server
    watched the same directory.

---

## PART 4 — What remains open

### 4.1 Unexplained
- **US/India risk geometry divergence** (R:R 1.37 vs 6.12, both Aug vintage).
  Two hypotheses tested and REJECTED: mandate vintage drift; the n>=60
  learned-percentile unlock. A9 measures it; the cause is unknown.

### 4.2 Unverified
- **The Lab UI has never been rendered.** Needs an authenticated session I
  cannot create. Compiles, mounted, API confirmed working.
- **`CAPITAL_ROTATION_PAPER_ENABLED`** in Vercel — redacted on pull, value
  unknown. Inert while DB flags are false.

### 4.3 Inert / incomplete
- **A1 always returns `insufficient_evidence`** — funnel projection not
  persisted. Deliberate refusal, but one of ten tests does nothing.
- **A6 window is 9 sessions** — `paper_position_marks` only begins 2026-08-17.
- A2 by-setup/regime/family breakdowns; purged walk-forward + regime holdout in
  A8.

### 4.4 Blocked on evidence, not work
- h60 labels ~2026-09-29; archetype IC ~late Oct; horizon-extension verdicts;
  H1-H4 hypotheses. All need >=20 more decision dates.
- Rotation re-enable: the 5 `p1_blockers` are the reopening criteria and must be
  ENFORCED IN THE EXECUTION PATH, not merely resolved.

---

## PART 5 — What I am asking you to do

**5.1 Re-derive, do not trust.** Especially:
- India sizing diagnosis (`docs/audits/2026-08-28-sizing-damage-diagnosis.md`).
  98 lots, correlations +0.344 / -0.128. Is the quartile gradient an artifact of
  something I did not control for — sector, entry vintage, holding period, or
  survivorship in the closed-lot cohort?
- The vol-budget unreachability algebra. I reproduced `estPortfolioVol` by hand;
  check I did not misread the correlation term.
- The claim that US selection "does not rank" (IC -0.012, NEGATIVE quintile
  spread) on only 17 qualifying dates.

**5.2 Audit the Lab for the failure mode it exists to prevent.** It is a
measurement instrument that can manufacture false confidence. Look for: metrics
that read as a pass when the underlying evidence is absent; cohort leakage
between accounting and learning; any path where `descriptive_only` could be
mistaken for a result; the `sampleStatus` floors.

**5.3 Verify the money-path guards are actually closed.** `execute_paper_exit`
(both migrations replay to the production function), the shadow-proposal
exclusions, the PaperTrader ladder fix, and that nothing in
`lib/analytics/alpha-diagnostics*` can reach a scorer, PaperTrader,
PositionMonitor, promotion, proposal, order or broker path.

**5.4 Fix what you find.** Where a fix is a money-path or policy change, stop at
the architecture gate.

**5.5 Architect and build, if warranted:**
- **A conviction-weighted sizing challenger.** The diagnosis motivates it; the
  evidence does not yet establish it. If you agree the diagnosis holds, design
  it as a measure-only A5/A6 paired counterfactual with predeclared thresholds
  BEFORE any live sizing change.
- **A1's funnel projection**, so one-tenth of the Lab stops being inert.
- Anything you judge higher-value than these.

**5.6 Push back if the priority is wrong.** I recommended fixing sizing next and
justified it partly by linking it to the dormant volatility budget. That link
was wrong — they are independent, and I said so only after measuring. Tell me if
the US selection problem, or something else, should come first.
