# Review brief for Codex — 2026-08-17 → 2026-08-28

Written by Claude for adversarial review. **Assume every claim below may be
wrong**; several claims I made with confidence during this stretch turned out to
be false, and two of the most useful corrections came from your last two
reviews. Please verify against production rather than trusting the prose.

Scope: **83 commits, 2026-08-17 → 2026-08-28** (`b096912c` → `e27aa811`).
Nothing live-money was touched. All autonomy flags remain false.

Two phases: **08-17..08-23** was evaluation-pipeline integrity (W1-W9) and the
US pricing outage; **08-24..08-28** was measurement instrumentation and the
Alpha Diagnostic Lab.

---

## PART 1 — What was built

### 1.0 Phase 1 (08-17..08-23) — evaluation-pipeline integrity

- **W4/W5**: `paper_position_marks` append-only ledger; `bench_session_date` /
  `bench_source` / `snapshot_type` on `paper_performance`. Migration
  `20260816180000`.
- **W2-full**: partial exits restored (`partial_exit_lot`).
- **W6**: run-accounting envelope wired to all four producers.
- **W7/W8/W9**: label-maturation coverage and starvation; `expectedNewestSession`
  added because the existing freshness rule accepted Friday's bar on Monday.
- **US pricing outage**: Massive key not entitled to `/v2/snapshot` — US had no
  working live price source. Yahoo promoted to primary for settled marks.
- **Mark corroboration**: independent-vendor cross-check;
  `MARK_CROSSCHECK_TOLERANCE_PCT` (advisory) split from
  `MARK_DISPUTE_REFUSE_PCT` (blocks marking AND exits).
- **Settle-check pass** (`/api/agents/settle-check`, cron 122) — next-day
  independent second opinion on marks.
- **PositionMonitor**: per-position try/catch isolation; market-scope guard.
- **Exit policy**: `swing` `target_pct` 20% → 8% on structural reachability.
- **h60/h120** evaluation horizons added to label maturation.
- **Promotion gate** segmented by provider regime; US edge/IC candles routed
  Yahoo-first to end EODHD exhaustion.
- Reconstructions: MSFT residual lot (cash drift -$185.20 → $0.0005), VOO
  benchmark series rebuilt on true closes, Aug 12/13 duplicate `bench_nav`.

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

### 2.1 Phase 1 (08-17..08-23) findings in existing code

8. **US had no live price source** — Massive key not entitled to `/v2/snapshot`
   or `/v2/last/trade` (403). Quantified NAV error at $57.79, which flipped a
   reported +0.239% to -0.339%.
9. **PositionMonitor blanked the whole book** when a single position's exit
   threw.
10. **A market-scoped run wrote the other market's book** (US EOD rows from an
    India-scoped run).
11. **`bench_nav` duplicated across sessions** — VOO's 08-11 close stored under
    both 08-12 and 08-13; series rebuilt.
12. **MSFT residual lot lost from the ledger** — `exit_reason='partial_target'`
    proved it a real position, not the phantom I first called it.
13. **The live `+20%` swing target was structurally unreachable** against an
    observed h10 p75 MFE of ~7.75%/8.93%.
14. **Yahoo `^NSEI` serves NULL closes and briefly a PROVISIONAL value** — on
    2026-08-18 that put 24245.699 into `paper_performance` when the settled
    NIFTY close was 24154.9 (0.375% wrong), undetectable from Yahoo alone.

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

### 3.1 Phase 1 (08-17..08-23) — the serious one first

11. **MONEY-PATH HARM. I over-claimed a guard's placement.** I wrote that
    disputed quotes were "refused for marking and for stop/target evaluation".
    The guard actually ran AFTER the exit loop. **Four positions closed on stale
    prices** (LULU at an Aug-14 price, MSFT at a carried Aug-17 mark), tainting
    8 lots. Fixed in `b5139775`, but the trades had already happened. Please
    verify the current ordering really does gate exits.
12. **My 0.1% dispute gate left India unmonitored for a session** — it compared
    a live quote against a settled close and unpriced all 13 India holdings.
    Fixed by splitting advisory from refuse (`46af1e5b`).
13. **Repeated a mislabel**: reported "US: all 13 marks from live quotes,
    stale=0" while `age_days=3.01` sat in the same row. You caught this.
14. **Circular verification**: "verified" the India benchmark against Yahoo —
    the same source that produced the value. Only Upstox settled it.
15. **A fix that changed nothing**: theme-scout model corrected in the code
    fallback while the `agent_config` DB row still held the old model.
16. **Two false nightly criticals from my own W6 wiring** (`eligible:
    result.scanned`, and `quote_stale` classified as `failed`).
17. **Wrong freshness rule reused**: claimed `isFreshSessionDate` "already
    answers correctly"; it accepted Friday's bar at Monday 16:15 ET.
18. **`.catch` on a PostgREST builder** — it is a thenable, not a Promise; the
    same pattern in the catch block masked the original error.
19. **Re-stamped 2026-08-18 India as `upstox+yahoo`** when no agreement had
    occurred — I had overwritten Yahoo's value with Upstox's. Reverted.
20. **A false migration-tracking finding**, and my "fix" inserted a duplicate
    row which I then deleted.

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

**5.2b Re-check the Phase-1 exit-ordering fix specifically.** Item 11 above is
the only defect in this whole stretch that caused real (paper) harm rather than
bad reporting. Confirm the dispute guard now precedes the exit loop and that
`MARK_DISPUTE_REFUSE_PCT` blocks exits, not just marks.

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

---

## PART 6 — The India sizing diagnosis, with everything needed to falsify it

This is the newest and least-tested claim in the brief, and the one I most want
re-derived. Full write-up: `docs/audits/2026-08-28-sizing-damage-diagnosis.md`.

### 6.1 The claim, in one line

India's score ranks forward returns (h10 rank IC +0.105, t 2.24), but position
size is set by **cash available at entry** rather than conviction, so the edge
is not concentrated where it should be: percentage profit factor **1.438** vs
currency profit factor **0.906** on closed lots.

**Caveat added after a survivorship test — see 6.3(1).** Both profit factors and
the quartile gradient come from the CLOSED cohort, which is biased: large
positions are disproportionately still open. The claim survives in weakened
form.

### 6.2 Exact queries — please re-run these

**(a) The profit-factor split that started it**

```sql
SELECT market,
  count(*) lots,
  round(sum(realized_pnl) FILTER (WHERE realized_pnl > 0)::numeric,2) gross_win,
  round(abs(sum(realized_pnl) FILTER (WHERE realized_pnl < 0))::numeric,2) gross_loss,
  round((sum(realized_pnl) FILTER (WHERE realized_pnl > 0)
        / NULLIF(abs(sum(realized_pnl) FILTER (WHERE realized_pnl < 0)),0))::numeric,3) currency_pf
FROM paper_trades
WHERE closed_at IS NOT NULL AND realized_pnl IS NOT NULL
  AND COALESCE(tainted,false)=false AND COALESCE(excluded_from_learning,false)=false
GROUP BY market;
```
Got: us 48 lots PF **0.735**; india 98 lots PF **0.906**.
Percent PF (from the Lab A3): us 0.969, india **1.438**.

**(b) The quartile gradient — the strongest part of the evidence**

```sql
WITH l AS (
  SELECT symbol, qty*fill_price AS notional, pnl_pct, realized_pnl,
         ntile(4) OVER (ORDER BY qty*fill_price) q
  FROM paper_trades
  WHERE market='india' AND closed_at IS NOT NULL
    AND qty IS NOT NULL AND fill_price IS NOT NULL AND pnl_pct IS NOT NULL
    AND COALESCE(tainted,false)=false AND COALESCE(excluded_from_learning,false)=false
)
SELECT q quartile, count(*) lots,
  round(avg(notional)::numeric,0) mean_notional,
  round(avg(pnl_pct)::numeric,2)  mean_return_pct,
  round(sum(realized_pnl)::numeric,0) currency_pnl,
  round((count(*) FILTER (WHERE pnl_pct>0))::numeric*100/count(*),0) win_rate
FROM l GROUP BY q ORDER BY q;
```
Got:

| q | lots | mean notional | mean return | currency P&L | win rate |
|---|---|---|---|---|---|
| 1 | 25 | 5,726 | +3.49% | +5,871 | 60% |
| 2 | 25 | 13,908 | -0.79% | -2,822 | 56% |
| 3 | 24 | 27,785 | +0.39% | +2,437 | 54% |
| 4 | 24 | 66,159 | -0.55% | -10,113 | 38% |

**(c) What actually drives notional**

```sql
WITH l AS (
  SELECT t.symbol, t.executed_at::date d, t.qty*t.fill_price notional,
         t.analyst_score, t.pnl_pct,
         (SELECT p.cash_balance FROM paper_performance p
           WHERE p.market='india' AND p.date <= t.executed_at::date
           ORDER BY p.date DESC LIMIT 1) cash_at_entry
  FROM paper_trades t
  WHERE t.market='india' AND t.closed_at IS NOT NULL
    AND t.qty IS NOT NULL AND t.fill_price IS NOT NULL
    AND COALESCE(t.tainted,false)=false
)
SELECT count(*) n,
  round(corr(notional, cash_at_entry)::numeric,3)          corr_cash,
  round(corr(notional, analyst_score)::numeric,3)          corr_score,
  round(corr(notional, extract(epoch from d))::numeric,3)  corr_time
FROM l WHERE cash_at_entry IS NOT NULL;
```
Got: n 98, **corr_cash +0.344**, **corr_score -0.128**, corr_time -0.233.
Also corr(notional, fill_price) = +0.003; notional spans 2,124 to 120,655 (57x);
mean score by size quartile is flat: 86.6, 82.6, 88.2, 81.1.

### 6.3 Confounders — number 1 is already CONFIRMED as material

1. **SURVIVORSHIP — TESTED, AND IT BITES. Read this before anything else in
   Part 6.** I published 6.2(b) from CLOSED lots only, then tested the
   confounder. Including the 14 open India positions marked to current price:

   | q | lots | of which open | mean notional | mean return | win rate |
   |---|---|---|---|---|---|
   | 1 | 28 | 2 | 6,031 | +3.07% | 57% |
   | 2 | 28 | 1 | 14,629 | -0.92% | 57% |
   | 3 | 28 | 3 | 30,425 | +0.44% | 50% |
   | 4 | 28 | **8** | 75,374 | **+0.07%** | 43% |

   Eight of fourteen open positions are in the LARGEST quartile and they are
   outperforming the closed lots. So: **"the largest positions lose money" is
   not supported** (Q4 goes -0.55% -> +0.07%), and the win-rate gradient
   shallows from 60->38% to **57->43%**. The mechanism claim (size tracks cash,
   not conviction) is measured at ENTRY and is unaffected.

   The honest surviving claim is weaker than my original write-up: allocation is
   uncorrelated with conviction and larger positions win less often, which
   WASTES the edge rather than reversing it. Please push on whether even the
   57->43% gradient is significant at n=112.
2. **Sector.** Large positions may cluster in a sector that simply fell. I did
   not condition on sector at all.
3. **Holding period.** Larger positions may be older, so the return windows are
   not comparable.
4. **Entry vintage / regime.** Q4 lots may cluster in one bad week.
5. **`cash_at_entry` is measured from the daily `paper_performance` row, not the
   intraday balance at fill time.** For multiple same-day entries it is the same
   value for all of them, which weakens the +0.344 in an unknown direction.
6. **n = 98 lots, one market, ~7 weeks.** Correlations of +0.344 and -0.128 have
   wide intervals I did not compute. No bootstrap, no significance test on the
   quartile gradient.
7. **`ntile(4)` splits by notional rank**, so quartile boundaries are
   sample-dependent; the gradient may not survive different bucketing.

### 6.4 The volatility-budget algebra — separate claim, also verify

Claim: `maxPortfolioVolPct = 2.0` is unreachable at `DEFAULT_DAILY_VOL = 0.02`,
so Rule 4 in `lib/portfolio/constructor.ts` can never bind. Zero firings across
1,513 constructor events / 60 days is consistent with this.

Reproduce `estPortfolioVol` (constructor.ts ~line 129) with equal weights:

```python
import math
def est(n, W, v, corr):          # n names, W gross fraction, v daily vol, pairwise corr
    w = W/n
    ssq = n*w*w
    var = v*v*(ssq + corr*((W*W) - ssq))
    return math.sqrt(max(0,var))*100
# worst case for diversification: few names, fully invested, all same sector
print(est(5, 1.0, 0.02, 0.6))    # -> 1.649  (cap is 2.0)
print(est(15, 1.0, 0.035, 0.3))  # -> 2.061  (per-symbol vol needed to breach)
```

**Check specifically:** did I read the cross term correctly? The code is
`variance += 2 * corr * wi * voli * wj * volj` summed over `i<j`, which I folded
to `corr * (W^2 - sum wi^2)`. If that is wrong the conclusion collapses.

**Also worth checking:** how often does `estimateDailyVolPctDetailed` actually
return `basis: "default"` in production? It only `console.warn`s, so there is no
queryable record. If real vols are being computed and are simply below 3.5%, the
framing changes from "the default makes it unreachable" to "the cap is above the
book's real volatility" — related but not the same defect.

### 6.5 What the diagnosis explicitly does NOT license

- Changing `position_size_pct`, `maxPortfolioVolPct`, or the allocation formula.
- Concluding conviction-weighted sizing would do better. That is the hypothesis
  this motivates, not a result it proves. A5's paired counterfactual is the
  instrument and has not been run over a long enough calendar (A6 currently has
  only 9 marked sessions).
- Any inference about the US book. Its percent PF is 0.969 and currency PF
  0.735 — both below 1 — with rank IC -0.012 and a NEGATIVE quintile spread.
  Sizing is not its binding constraint; selection is.
