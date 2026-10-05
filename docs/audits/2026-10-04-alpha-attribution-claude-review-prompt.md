# Claude review prompt — Kairos alpha attribution and remaining work

You are reviewing Codex's 2026-10-04 diagnostic-only changes on branch
`codex/alpha-diagnostic-completion`. First read `AGENTS.md`, `WORK_LOG.md`,
`PRD.md`, `knowledge/KNOWLEDGE_INDEX.md`, and
`features/alpha-diagnostic-lab/FEATURE_ARCHITECTURE.md` plus its approved
measurement-integrity amendment. Respect the work-claim protocol and inspect
the actual diff against `origin/main`; do not accept this handoff as proof.

## What Codex changed — attack it

1. Replaced Alpha Diagnostic A1's hardcoded empty funnel with a read-only
  projection from exact `decision_observations.signal_id`, executable
   deterministic equity `agent_signals`, `pipeline_stage_events`, and
   signal-linked `paper_trades` for each market. The projection excludes
   holding reviews, picks the first scored and first eligible entry-candidate
   decisions independently per symbol and market-local session *before*
   looking at returns or stage events, separates
   scored/eligible/selected/filled/closed, retains missing h5/h10/h20 labels
   as null, and does not treat a stage-event “filled” claim as a fill without
   a matching lot. Partial exits stay “filled” until every associated lot is
   closed. A1 remains descriptive, never a policy pass.
2. Removed the silent 1,000-row cap on A6 position marks, and paginated the
   performance and lot ledgers with stable ordering. The diagnostic metric and
   plan versions changed so old immutable runs cannot be reinterpreted.
3. Removed a false 52-week-high proximity fallback. When no actual price is
   available, `scoreFundamentals` no longer substitutes the 200-day moving
   average and calls the result “distance from the high.” This measure remains
   observational, not a score input or a trading veto.
4. Added pure projection tests, route contract tests, and score-governance
   tests. Check test quality with adversarial mutations rather than counting
   green tests.
5. A later production audit found that v6 Dimension Rank IC counted
   non-session-validated weekend/catch-up research as independent sessions.
   For example, 43 US observations on 2026-08-08 and 16 India observations on
   2026-08-15 had `session_validated=false` and an `as_of_session` on the prior
   trading day. Codex's v7 diagnostic retains them in availability counts but
   excludes them from predictive IC and groups validated rows by the signal's
   market-local `as_of_session`. It also refuses `Number(null) === 0` for a
   missing factor score or forward return. The old v6 rows are immutable and
   should be marked superseded, not silently compared with v7.
6. The separate code-version IC loader consumed the same diagnostic function
   but originally omitted source-session proof. It now joins the exact
   `signal_id` to `agent_signals`, supplies validated market-local
   `as_of_session`, and reports the provenance-excluded count per cell. It also
   stopped substituting raw `fwd_return` for a missing
   `benchmark_neutral_return`. Check that these changes do not create a false
   regression alert when a code-version cell becomes insufficient. Its API
   reports `methodVersion=v2_validated_session_benchmark_neutral`; never
   compare the old dynamic view as if it used the same cohort or outcome.

Review especially these failure modes: a stage event from the wrong market or
session; multiple same-day decisions and deduplication; event timestamps around
India/US session boundaries; a fill linked to a later same-day signal rather
than the first decision; partially closed lots and excluded/tainted lots;
unlabelled decisions; duplicate event retries; high-cardinality attrition
reason text; A1 h5/h20 maturity versus the headline h10 status; `pipeline_stage_events`
being fail-soft; PostgREST pagination ordering and query time under the
120-second route limit; fingerprint completeness; and whether the
`observation_labels` left join changes any other Alpha Diagnostic cohort.

## Independently verified production constraints

- The latest Alpha Diagnostic runs for both markets were `data_invalid` at A0.
  US lacks completed clean EOD snapshots on 2026-07-08, 2026-09-08 and
  2026-09-11; India lacks 2026-08-28. On three dates there is only an intraday
  snapshot, and on US July 8 no row. Do not relabel intraday rows as EOD,
  invent missing marks, silently shorten the audit window, or weaken A0.
  Consequently the new A1 code cannot yield an interpreted production verdict
  until data truth is resolved under an approved contract. Propose a separate
  explicitly labelled post-gap contiguous-window diagnostic if warranted;
  do not smuggle it into A0.
- Production `paper_trades.signal_id` is present on every observed equity lot
  (US 125/125, India 162/162 at inspection). Current executable entry-candidate
  observations with `as_of_session` are US 632/632 and India 424/424; this
  supports exact joins, not a performance conclusion.
- An initial read-only SQL cross-check exposed a crucial cohort issue: the
  first scored decision and first eligible decision can differ on the same
  symbol/session. Codex corrected A1 to preserve both. A second independent
  SQL projection counted scored/eligible/selected/filled/closed as
  US 1,371/651/123/10/9 and India 796/530/362/70/65 at inspection.
  Recompute against the actual implementation before treating these as
  verified; A0 remains invalid regardless of those counts. The low US fill
  count in this exact-first-decision cohort is a coverage/decision-linkage
  question, not proof of poor selection.
- Production 52-week-high edge status is `measure_only` in both markets. Most
  recent observed US 20-session IC was about +0.026, t +0.42, retrospective
  current-universe quality; India 5-session IC was about +0.004, t +0.18.
  Neither licenses a high-price risk veto or scoring promotion. Verify on fresh
  data before repeating these figures.

## Finish the tests and review questions the owner asked for

Reproduce US and India market-local portfolio/benchmark series first; separate
cash drag, selected-name returns, unfilled eligible candidates, position sizing,
exit timing, price-mark errors, and benchmark coverage. Then compare each
deterministic composite and dimension score with *subsequent* benchmark-neutral
h5/h10/h20 returns in the correct entry-candidate cohort. Report calendar
sessions, labelled counts, overlap-adjusted effective sample sizes, IC and
t-stat, with holding reviews analyzed separately for exit research. Do not
promise that Kairos can beat VOO, QQQ, XLK, XLF, or India benchmarks “always.”
For each agent/stage, identify the exact evidence that would convict it and
avoid turning a hypothetical missed winner into a guaranteed attainable fill.

Verify the 52-week-high mechanism from source to UI: actual price as of the
decision, same-session/point-in-time 252-session high, corporate-action basis,
provider freshness, market/asset-class suitability, and any gap between the
UI evidence and the `high_52w_proximity` edge. Research says proximity can be
a *momentum* feature, not automatically a danger signal. Keep it measure-only
unless a frozen, market-local, paired portfolio replay clears the approved
promotion gates after costs and drawdown checks. Leveraged ETFs and crypto
must not inherit an equity threshold by analogy.

For the Dimension Rank IC repair, independently re-derive the source-signal
cohort and check the choice to require `session_validated=true`, the treatment
of valid late-night/next-UTC-day decisions, `as_of_session` joins, code-version
lineage, the availability denominator, and the revised per-market h5/h10/h20
IC/t-stat. If the validated cohort still includes non-trading sessions or
excludes a legitimate decision, correct the projection and bump the plan
version again rather than overwriting any prior run.
Also check the code-version IC source loader and its missing-label behavior.

Finally verify the complete test suite, typecheck, production build with safe
non-secret build placeholders if local public Supabase variables are absent,
the deployment (if any), the next scheduled run, and the owner-visible UI.
Report every failure and its cause. Codex's final pre-commit suite passed
3,682 tests with 7 skipped; TypeScript and a local production build passed.
Re-run them independently, and do not confuse local verification with a
successful production deployment or scheduled run. An earlier build could not
prerender `/login` because this clean worktree lacked public Supabase build
variables; the successful build used safe non-secret placeholders.

## Hard boundaries and expected handoff

Do not change scores, weights, entry/exit thresholds, capital rotation,
broker settings, paper positions, or live trading based on these diagnostics.
Do not fabricate EOD history. Do not touch the original dirty checkout at
`C:/Users/vaibh/OneDrive/Documents/Startup/FinanceOS`; use the attached clean
worktree/branch and preserve other agents' changes. If a finding requires a
new architecture decision, document the proposal and ask Vaibhav rather than
quietly making a money-path change. Finish with: defects found and fixed,
exact tests/build/deploy evidence, production measurements and their limits,
what remains blocked, and the one next safe action for each blocker.
