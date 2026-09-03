# Codex brief — three-day review, open items, and next steps

Date: 2026-09-03
Scope: everything committed 2026-08-31 → 2026-09-03 (41 commits, `07d142ab..146e9b89`)
Recommended model: **sol / max** — this is diagnosis + adversarial review, not planned implementation.

---

## 0. Your job

1. **Review architecture → implementation** for the work listed in §2. Find what is wrong,
   half-wired, or claimed-but-unproven.
2. **Fix the issues you confirm.** Prefer the root-cause fix at the shared call site over a
   per-caller patch.
3. **Complete the next items in §4 where the data is already sufficient.** Where it is not,
   say exactly what is missing and stop — do not synthesise a result to fill the gap.
4. Answer the questions in §5.

Treat every claim in this brief as a claim to verify, including the ones marked verified.
Several statements in this repo's history were retracted after measurement; assume this brief
contains at least one error and look for it.

---

## 1. How to verify anything here

- Production DB is reachable via the Supabase MCP (`execute_sql`). Read distributions, not single rows.
- Full test suite: `npx vitest run` (tests live in BOTH `tests/**` and `lib/**` — a focused run
  has looked green twice while the build was red). Then `npx tsc --noEmit`, then `npm run build`.
- Do NOT run two `npm run build` concurrently; they share `.next/` and both fail.
- PostgREST silently caps reads at 1,000 rows. A larger `.limit(n)` is ignored, not an error.
  Paginate any query whose result feeds a percentile, an IC, or a cross-section.
- Schema-coupled code: confirm the migration is applied to the target DB (`information_schema`),
  not merely present in `supabase/migrations/`.

---

## 2. What shipped in three days

### 2a. Execution cost (2026-09-02, `b3f505d6`)

- `spread_applied` is a **fraction of price**. `costNet()` divided it by `fill_price` as though it
  were an absolute price offset, understating cost by a factor equal to the price: 0.0009% on a
  $57 name, 0.0001% on a $417 name, against a true 0.05%. `slip()` in the same file already had it
  right (`fraction -> %`), so `performance-metrics.ts` contradicted itself.
- The strategy replay charged **nothing**: `compileSpec` never set `costPct`, so the simulator's
  multiplier was 1 and every replay was a frictionless gross number — optimistic against the paper
  book it is a counterfactual for. Both sides now pay; `compile.ts`'s own cash ledger charges the
  full allocation so it cannot drift richer than the simulator.
- Measured first: **205/205 fills across both markets carry `spread_applied = 0.00050` exactly,
  zero variance.** The fill path applies a hardcoded constant and stores it back, so "realized
  cost" is the assumption echoed. Calibrating a cost model from our own fills would be circular.
- One number had five encodings (`1.0005`, `0.0005` x3, `MODELED_SLIP_PCT = 0.05`) in two units
  across three files; all now derive from `MODELED_SLIP_FRACTION`.
- **Review this:** is 5bps/side defensible for India (`.NS` mid-caps like HAPPYFORGE, LAMBODHARA,
  GKSL) or only for US large caps? `computeFillPrice` has a real bid/ask path that never engages
  because `ask` is null in production — should that be fixed, and with which provider?

### 2b. LLM reasoning budgets (2026-09-02, `7ccbf172`, `0717e44f`, `213e0a7f`)

- All 213 LLM failures in 14 days were one error: DeepSeek reasoning models emit
  `reasoning_content` before `content`, and a small `max_tokens` returns `finish_reason=length`
  with empty content. A retry existed but the control flow prevented it from firing.
- `REASONING_MIN_TOKENS = 16000` floor applied before dispatch and on all fallback paths.
- `maxDuration` raised where the larger budget made runs longer (`macro-read` 60→150,
  `mentor/evaluate` →150).
- **This one is NOT confirmed fixed — see §3.**

### 2c. Session-vs-calendar defects (2026-09-01/02, `3302591c`, `b3fa2a72`, `fe0f7716`, `d9bf2788`)

- Prewarm freshness used calendar hours, not market sessions.
- The freshness monitor demanded a scope the prewarm never refreshed.
- The India quote "dispute" was a **session mismatch**, not a vendor disagreement — the
  "disagreeing vendor price" was Yahoo's own previous close. Session gate now runs BEFORE price
  comparison; unknown session counts as mismatch (fails toward "still priced").
- `walkForwardFolds` purged in calendar days, so labels leaked across folds.
- **Recurring defect class, name it when you see it again:** two components holding different
  ideas of the same set — prewarm vs monitor scope, cross-check vs mark-ledger sessions, profile
  backfill vs decision universe, sector floor vs Spearman floor, and (still open, §4a) edge
  readiness spacing vs `folds.ts` step rule.

### 2d. Learning / diagnostics (2026-09-01/02)

- `b71c0103`, `cd9fce10`, `5adae970`: per-session IC series, `tStatistic`, `sampleStdDev`, and the
  dimension IC panel with always-on variable explainers. Chart logic moved to
  `lib/learning/dimension-ic-chart.ts` because vitest globs are `tests/**`/`lib/**` and cannot
  transform `.tsx` — the first version of that test never ran at all.
- `efee1352`: alphalens method port — `lib/learning/factor-quantiles.ts`, quantile gradient and
  rank stability, `MIN_PER_BUCKET = 3`, degenerate-sd guard (a `spread_std_error` of 1.16e-18
  passed a `> 0` check and produced t ≈ 1e15).
- `94917746`, `1ec12c59`: `lib/scoring/sector-taxonomy.ts` — 45 production labels → 11 GICS
  sectors + 5 fund asset classes. Fixes a real scoring bug: `rank.ts` needs
  `RANK_MIN_GROUP_EQUITY_US = 20` per group and the median raw label had ~2 symbols, so nearly
  every sector group collapsed into the market-wide fallback while presenting a sector-partitioned
  design.
- `89abb4ae`, `7a22fb28`: sector-regime Stage 1, measure-only. Reports IC over **names** and over
  **sectors** separately, because a sector signal gives every name in a sector the same value —
  40 names carrying 4 distinct values are 4 clusters, not 40 observations.
- `6d3f7a45`: mentor rubric shows where points went; sums the categories rather than trusting the
  model's stated total; a missing category scores zero.
- `70a9eef2`: `setup-experts` was blocked by a hardcoded string, not by the data. I had told the
  user this was "the one item blocked by a bug you can fix today" and then **retracted it** —
  measurement showed 1,279 observations already carry 2–4 experts.

### 2e. Replay seam (2026-09-01)

- `4b32d8ca`, `1003249c`, `a4294e6f`, `3629cd7e`: replay seam with mandatory negative controls;
  exits carried no quantity (the simulator rejected them as `invalid_exit` — 1 fill and 96
  rejections on 1,280 real VOO bars); price provenance + restatement detection; replay cash drift;
  and a refusal to seal a full-sample replay as `purged_temporal_oos`, since that would misstate
  its provenance.

---

## 3. Claimed fixed, NOT actually confirmed — check these first

**LLM truncation (§2b) is the one I would not sign off.**

`llm_call_log` failures by day: 08-31: 17/63 · 09-01: 25/66 · 09-02: 11/75 · 09-03: 0/22.

The fixes deployed 2026-09-02 ~10:20–10:45 UTC. **Six failures occurred AFTER that**, at 12:34,
12:48, 12:49, 13:00, 13:02 and 13:30, on `research`, `macro-read` and `mentor-evaluate`. All show
`finish_reason=length` with `reasoning_len` ≈ 6011 / 6064 / 6606, and all say
"transient truncation, retrying via same-tier fallback".

Three hypotheses, unresolved — determine which, with evidence:

1. `reasoning_len` is a **character** count, so ~6k chars ≈ ~1.5k tokens, meaning the cap in force
   was the original 1500 and **the floor did not apply on those dispatch paths**.
2. These rows are **first attempts** of a retry that then succeeded, so the flow was fine and the
   per-attempt logging makes it look like a failure. If so, `success=false` on a recovered call is
   itself a reporting bug.
3. Deploy lag, or a path that reads `max_tokens` from somewhere the floor does not reach.

09-03 being clean is **22 calls**, which is not enough to call it. Confirm over a full day and say
which hypothesis held.

Note also the open warn alerts `reasoning-budget-floored:{research,macro-read,mentor-thesis}` —
these fire when a flow asks for 1500–4096 and gets raised to 16000. Should the **call sites** be
corrected so the floor stops being load-bearing?

---

## 4. Open items

### 4a. technical-calibration (the next item, and it has a blocker)

State: `validation_windows_observed = 0` and `median_net_of_fee_ic` NULL across **all 66**
edge/market/horizon combos. The validation phase has never run. `edge-ic/route.ts:158` hardcodes
`net_of_fee_ic: null` and `turnover: null`, and writes `evidence_quality = EDGE_EVIDENCE_QUALITY`
while `readiness.ts` requires `VALIDATION_EVIDENCE_QUALITY = "pit_walk_forward_cost_adjusted_fdr"`.
So validation can never advance from the current producer.

**The machinery already exists and is dormant:** `lib/edges/folds.ts`, `oos-runner.ts`,
`oos-orchestrator.ts`, `pit-universe.ts`, `pit-snapshot.ts`, and `oos-experiment.ts` with a
pre-registered `costPolicy.oneWayBps`. Nothing in `app/` calls any of it. This is wiring, not a
build from scratch. Set `costPolicy.oneWayBps = 5` from `MODELED_SLIP_FRACTION` so replay, paper
book and validation price friction identically.

**Blocker to settle before building on it.** `readiness.ts:6` sets
`INDEPENDENT_WINDOW_DAYS = 5`: windows count as independent if their end dates are ≥5 **calendar
days** apart, regardless of horizon. `folds.ts:77` in the same subsystem refuses the mirror-image
case outright — `stepSessions < horizonSessions` is rejected because "consecutive as-of dates would
share forward-return windows, so the IC series would be autocorrelated by construction" — and
applies a Newey-West HAC lag. Two components, one subsystem, contradictory rules.

Measured: window gaps average **6.27 calendar days, identical across h=5/10/20**, over a **51-day**
span (2026-07-08 → 2026-08-28), 9 distinct windows. At h=20 consecutive windows share ~78% of their
forward return. "Six stable weekly windows" is satisfied by seven weeks of one market episode.

Corroborating: `positive_windows` is sharply **bimodal** — 21 combos at 0/6, 27 at 6/6, only 4 in
between. Sign is near-constant within an edge. Meanwhile **1 of 66** passes the t-gate
(`volume_breakout` US h10, median t = 1.55) and the population averages `median_ic` ≈ 0.003.
Consistent sign with no significance is what one episode viewed six times looks like.

**A correction to carry forward:** I predicted 6/6-positive would concentrate at h=20 if overlap
drove it. It did not — 40.9% / 45.5% / 36.4% by horizon, **lowest** at h=20. That mechanism is
wrong. The overlap defect is real and measured, but what drives the sign agreement is that all six
windows sample the same seven weeks at every horizon. Do not repeat the h=20 claim.

Proposed fix, for your review: make spacing horizon-aware (≈ `horizon x 7/5` calendar days, matching
`folds.ts`). Effect: h=10 drops to ~4 windows, h=20 to ~2, so most combos demote to `collecting`.
That moves technical-calibration **further** from ready, which is the honest direction — a
cost-adjusted validation stacked on the current gate would launder one episode into a
validated-looking edge. `tests/edge-readiness.test.ts` pins the flat rule (asserts `2026-07-18` is
dropped and `07-13` kept), so this is a deliberate gate-policy change with a test to rewrite.

**Decide and justify:** fix the gate first and accept the demotion, or run the OOS validation on
today's gate and label the provenance honestly? I recommend the former.

### 4b. India quote corroboration — fix worked, residual remains

`position-monitor-quote-disputed:india` (critical, open since 2026-08-26) and
`position-monitor-price-unavailable:india` (HAPPYFORGE.NS, LAMBODHARA.NS, GKSL.NS) both **resolved
2026-09-03**. The three positions are priced and evaluated again.

Residual, new warn: `position-monitor-cross-session-mismatch:india` — **11 quotes uncorroborated**
because the cross-check vendor returns a different session for India. Correctly downgraded from
critical to warn, marks recorded as uncorroborated. This is a coverage gap, not a safety failure.
**Question: which second India vendor returns a same-session price?** Until one exists, 11 marks
are single-sourced.

### 4c. Benign alert misclassified as a blocker

`run-accounting:paper_trader:india` reads "16 eligible, 0 succeeded" and is styled as blocked, but
the detail is `expected_skip=13` (`portfolio_constructor_no_room=6`, `reentry_cooldown=1`, …),
`unavailable=3` (`quote_stale`), **`failed=0`**. The book was full. This is alert semantics, not a
money bug — but it costs attention every day. Fix the classification.

### 4d. Still open, lower priority

- `freshness:price-cache-us-symbols` contract breached (warn, 09-02).
- Three India benchmark ETFs stale (JUNIORBEES, BANKBEES, ITBEES) — 08-31 vs book 09-02.
- `data-availability:{us,india}:fundamental` at 83%.
- `evidence-router:shadow-parity:ready` — parity bar met 2026-08-27 (US 5 days / India 6 days) and
  nothing has acted on it. Is the router shadow ready to promote, and what is the gate?

### 4e. Owner-only, cannot be done by an agent

- **Webull connection expired** (critical, 09-02) — needs the user's OAuth reconnect.
- **Kite session expired** — daily re-login by the user.
- `TRANSCRIPT_API_KEY` absent, so the YouTube transcript path is unusable. Account creation is
  prohibited for agents; the user must supply the key.

---

## 5. Questions to answer

1. Which of the three hypotheses in §3 explains the post-fix truncation failures?
2. Should `INDEPENDENT_WINDOW_DAYS` become horizon-aware before any OOS validation runs? (§4a)
3. Is 5bps/side defensible for India mid-caps, or does the cost model need a per-market /
   per-liquidity term? (§2a)
4. Should `computeFillPrice`'s real bid/ask path be made to engage, and with which provider?
5. Which second India vendor gives same-session quotes for cross-corroboration? (§4b)
6. `evidence-router:shadow-parity` has been READY for a week — promote, or is the parity bar the
   wrong gate? (§4d)
7. Macro dimension Stage 2 was left on an unmade decision: **sizing throttle vs eligibility
   cliff** in a dangerous regime. Which, and on what evidence?

---

## 6. Hard rules — these are not negotiable

- **Frozen history:** annotate, never re-decide. Sealed replays and recorded decisions are not
  rewritten; a plan-version bump is required when a metric's meaning changes.
- **No silent money-path defaults.** Every default/fallback on a scoring, sizing, eligibility or
  exit path needs explicit evidence provenance, or removal. Report each one's production hit rate.
- **Prove US and India separately.** A cross-market aggregate cannot validate a money-path rule.
- **Availability comes from the authoritative mask/evidence state**, never from a non-null
  placeholder score.
- **A scoring review is incomplete without SQL evidence** or an explicit blocker saying why
  production evidence could not be obtained.
- **Measure-only means measure-only.** No new route may write to a scoring, sizing, entry, exit,
  order or broker path without a separate governed decision.
- **Docs are part of the change.** Update the relevant `docs/arch/` chapter and, for any
  agent-to-agent flow change, `public/agent-diagrams/system-map.json` in the same commit.
- **Tests must be real detectors.** Mutation-check anything load-bearing: revert the fix and prove
  the test fails. Two tests in this window asserted the wrong thing and passed regardless — one
  compared `undefined < undefined` because the simulator returns `endingCash`/`realizedPnl`, not
  `finalNav`.
- Do not report a local verification as a deployment verification. A local dev server has no
  function timeout; `mentor/evaluate` ran 94.8s locally and would have 504'd in production.
