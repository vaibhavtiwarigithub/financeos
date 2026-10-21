# Upgrade Path attribution matrix (baseline audit 2026-09-28; production recheck 2026-09-29)

## Production recheck — 2026-10-20

The ledger is still **not a portfolio-P&L attribution system for every Upgrade
Path item**. A read-only production query found 19 rows, all `US / international-allocation /
matched_replay / measured`, with `as_of_session` from 2025-07-18 through
2026-10-19. There are no production attribution rows for India or for the
stock-paper shadow programs. These international-allocation rows remain the
synthetic fixed-allocation comparator described below; do not present them as a
Kairos-paper-book counterfactual or use their average as the expected impact of
another upgrade path.

The Markowitz/covariance shadow is separately collecting risk diagnostics
through `pipeline_stage_events`, not writing attribution rows: 19 US events
through 2026-10-20 and 15 India events through 2026-10-19. Those events do not
measure P&L improvement. Candidate histories below the 60-session contract
remain `unmeasurable`, and the risk-only variant does not estimate expected
returns.

The remaining program-specific producer gaps and owner-defined replay arms in
the matrix below therefore remain open. A row in the generic shadow book,
signal-level IC, trade-level outcome, or covariance diagnostics is not a
substitute for paired baseline/variant portfolio replay.

## 2026-09-29 follow-up

Production recheck confirms the attribution ledger remains a synthetic fixed-allocation diagnostic, not Kairos-book P&L. The latest `international-allocation` producer run (2026-09-28, observed session 2026-09-25) refused to append a second immutable attribution row for the same program/version/session because its recomputed snapshot differed from the existing row. The existing result remains unchanged: net incremental return **−6.3191%**, 20 independent 63-session blocks, t = **−0.6947**. This is not evidence to promote international allocation. The source replay fingerprints for the same end date differ between Sep 26 and Sep 28; the underlying historical-price revision has not been identified, so the historical row must not be rewritten or treated as an idempotent retry.

The producer currently mislabeled this integrity refusal as a generic `error` because it inspected a nested field while the route returns top-level `attributionState`. The release branch fixes the classification to `blocked` and records the observed session; the existing historical producer row is retained as-written pending the next verified invocation.

Two approved foundations now have their additive production migrations applied (Supabase versions `20260929215738` and `20260929215748`): the measure-only chart-pattern ledger and the paper-only 100% gross-exposure ceiling. Their application code is in the release branch but is not considered live until the matching code release is deployed. Neither change establishes P&L benefit or authorizes orders.

Observation: production project `dionkikgdmlaotvtbnfr` read at ~13:15-14:00 UTC 2026-09-28; code at `main` `0d6489c2` plus the working branch. Local tests do not count as production evidence. Nothing here enables trading, rotation or promotion, or changes any score, weight or threshold.

Registry state: 6 matched-replay programs (exit-geometry, exit-stop-shadow, score-exit-shadow, setup-experts, capital-rotation, international-allocation) and 2 paper-cohort programs (challenger-validation, downside-hedge) are performance-eligible; the rest are operational-only and must never be presented as a P&L benefit.

| Program | Class | State | What exists in production | Blocker / exact next action |
|---|---|---|---|---|
| exit-stop-shadow (ATR 2.8x) | matched replay | **Collecting (US only)** | Forward paired shadow book: seed snapshot 2026-09-25 written (13 positions, cash 3,079.49, shadow NAV 9,998.02 at raw closes vs paper NAV 9,998.74). Collector `POST /api/agents/atr-stop-forward?market=us` scheduled 22:15 + 23:45 UTC weekdays; Massive corporate-action coverage complete for all 13 held names; producer-run health ledger live. Decision-level weekly collector separate (6 rows). | First real step is the 2026-09-28 22:15 UTC run (not yet observed). No attribution row: needs 2 complete non-overlapping 10-session blocks (~a month) and only post-2026-09-27 entries with a decision-time ATR can differ between arms. **India: blocked**, no corporate-action source covers NSE names. |
| international-allocation | matched replay | **Measured, synthetic only** | 3 attribution rows (latest as_of 2026-09-25), replay producer scheduled weekdays 23:45 UTC. | It is a fixed-allocation diagnostic, not Kairos book P&L; the UI labels it so. No further action. |
| score-exit-shadow | matched replay | **Producer missing** | Decision-level `score_exit_shadow_runs` (88 rows), weekly collector. | The variant is undefined for a portfolio replay: the paper book already applies score exits, so a paired book needs an owner-approved definition of what the baseline does versus the challenger, plus the timestamped holding-score path. Propose the definition, get approval, then reuse the ATR forward-book machinery (`atr-forward-run.ts` supports confirmed score exits in the stepper). |
| exit-geometry | matched replay | **Producer missing** | Read-only counterfactual grid over `observation_labels`; writes nothing. | Grid has 14 predeclared arms; a paired book needs the owner to pick which arm(s) to test (the ATR stop is the arm that won the grid). Then a variant-geometry generalization of the ATR forward book. |
| setup-experts | matched replay | **Producer missing** | 15,242 `shadow_decisions` (would-enter only). | Needs point-in-time candidate sets joined to matured prices and both rankings under identical capital, name caps and costs; a different replay shape from a stop replay. Not buildable as a small extension. |
| capital-rotation | matched replay | **Blocked** | 2 executed paper rotations (July); paper execute flags off since 2026-08-11. | Blocked on `docs/audits/2026-08-25-rotation-unreachable-trace.md`, exact lot/tax reconciliation and turnover. Do not enable execution. |
| challenger-validation | paper cohort | **Nothing to run** | 2 `paper_active` strategy versions, 0 `shadow_paper` challengers. | Needs a validated challenger in the single shadow slot. |
| downside-hedge | paper cohort | **Nothing to run** | 0 hedge events; campaign disabled. | Owner must enable shadow collection first. |

## Verified this session (production, read-only unless stated)

- Migrations applied and verified: `upgrade_path_producer_runs`, `corporate_action_source_coverage`, `schedule_atr_forward_shadow`, `price_prewarm_dst_pairing`. Tables: RLS on, owner-read policy, no anon access.
- pg_cron jobs live: six weekly evidence jobs (Sun 03:40-04:30 UTC), three ATR-forward jobs, US price prewarm now DST-paired (`35,40 21` Apr-Oct, `35,40 22` Nov-Mar), India prewarm `35,40 10`.
- Price-cache freshness: post-close prewarm was failing ~78 symbols daily because `providerCachedFetch` served the morning's same-day cache; fixed with `forceRefresh` for known-stale symbols (`bf1db4a6`). The freshness monitor now judges a session 3h after the close (`settleHours`) and drops research-disabled, unheld names from the required scope. First live confirmation is the 2026-09-28 21:35 UTC run.
- Delisted tickers IRBT (2025-12-22), ABB (2023-05-23), TMHC (2026-07-27) were still scored daily with no price data; `watchlist.research_enabled` set false (reversible; evidence: Massive reference `delisted_utc`).
- DSKULKARNI.NS is a thin India microcap (0-200 shares/day; Yahoo omits no-trade days), which explains one recurring post-close prewarm failure; not a code defect.

## Not verified / not done

- No local production build (native memory failure); Vercel builds are the only build evidence.
- Lint not run as a gate (see WORK_LOG).
- The 2026-09-28 22:15 UTC collector step and 21:35 UTC prewarm are pending at the time of writing.
