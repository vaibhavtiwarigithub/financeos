# Discovery expansion — implementation and rollout

Date: 2026-11-03. Approved architecture: `DISCOVERY_EXPANSION_ARCHITECTURE.md`.

## Implemented

- The existing weekly market-local Learner runs deterministic reference experiments before the optional model loop. It tests supported catalog strategies, fixed 70/100 recorded dimension-score hypotheses, and bounded confirmation pairs. Five dimensions are supported: fundamental, technical, sentiment, macro and insider. US ordinary equity/ETF and India remain distinct. The ordinary ETF cohort excludes leveraged/inverse funds. Novel model proposals can use one or two allowlisted conditions with fixed thresholds; they cannot supply code, arbitrary symbols or orders.
- A fixed worklist, six-seed/four-pair ceiling and 45-second between-trial budget retain a continuation cursor and eligible queue. A `strategy_discovery` child run records attempted, unsupported, failed, disabled, capacity and deferred outcomes. Source reads share an in-cycle cache. There is no added schedule, model, inference ceiling or paid service.
- Trial registration precedes performance screening. The database supplies the same fingerprint as its configuration constructor and freezes the first historical cutoff. Repeated screens cannot silently extend their final period or count twice. The constructor's pgcrypto namespace and historical-evidence payload defects are repaired.
- Cached daily-bar diagnostics include costed next-open replay, a fixed 70/30 split, fixed expanding-origin folds, benchmark trend/volatility slices and same-universe/cutoff/cost parent comparisons for reference combinations. Folds overlap the holdout; they are descriptive, selected historical evidence, not independent tests or proof of alpha. Forward selection retains its existing matched-cohort, maturity, nonoverlap and multiplicity gates.
- The v3 recorded-score grammar reads actual available/applicable same-session observations known by the session close. It never reconstructs old scores, fills missing dimensions with 50, carries a prior day's score forward, or substitutes a later observation. Existing price-rule v2 semantics remain unchanged. Missing retained history remains insufficient.
- The natural forward collector evaluates the newest completed candle directly, without demanding a nonexistent next-day fill bar. Its v2 evidence binds the baseline and candidate to the same preclose observation. Later research cannot become an earlier baseline. Labels remain append-only. The selector and owner comparisons exclude older timing contracts. Paper preference reads the preceding completed session, repairing the escaped date-regex/current-research-date mismatch; all entry/risk gates still apply.
- The existing Learner receives versioned dimension diagnostics, exact-model council evidence and source-policy quality comparisons. At most two allowlisted official methodology reads fit inside its existing loop. Source text is untrusted reference material, never executable instructions or proof of account entitlement. Formula proposals reuse the observational feature registry; source hypotheses reuse existing research records.
- Formula measurement uses only post-declaration observations, explicit markets, available/applicable inputs and benchmark-neutral labels. Raw feature reads are batched and reject partial cohorts. Unchanged evidence is not recounted. A new measurement contract preserves legacy histories rather than mixing them with corrected IC. Access requires owner or cron authentication.
- Learning shows the last actual discovery cycle and per-attempt blockers, including fixed dimension rules. The supervisor recognizes the discovery producer. India shortlist expiry skips supported special sessions while counting regular sessions.

## Verified production facts before release

The latest weekly Learner starts were October 30 at 21:00:02 UTC (US) and 20:30:02 UTC (India), before the prior autonomous-rule release became READY at 21:10:10 UTC. No subsequent weekly discovery cycle was recorded as of this review. Production contained zero template configurations, decisions and outcomes. This is not a week of failed strategy tests and does not establish that any discovered strategy works.

The 16:00:05 UTC November 3 evolution-supervisor snapshot was done, state attention, with no read failures. Attention is a triage queue, not a supervisor failure.

Migration `20261103173459_strategy_prescreen_trial_contract.sql` is applied and verified in production. The new RPC is invoker-security, has a pinned empty search path, rejects anon/authenticated execution and allows service role. Five mutable-search-path advisor findings are removed. A rollback-only service-role metadata test verified identical preregistration/constructor fingerprints, immutable first cutoff, one trial across retries and a valid draft-to-shadow transition; no fixture rows remain. No broker, research or trading route was invoked.

Codex's existing hidden supervisor was restarted after process/config-existence checks and completed 30 already queued jobs. Claude stopped on `authentication_required`; owner is signing in. Kite remains intentionally blocked pending daily reconnection, per owner instruction. Neither blocker is labeled healthy.

## Remaining gates and authority

The next natural weekly Learner cycle must verify real seed attempts and persistence; natural ResearchAgent sessions must verify collector outcomes. No scheduled route is manually invoked to manufacture acceptance. Forward labels must mature before selection can pass; neither healthy agents nor a favorable historical replay establishes improved returns.

Arbitrary new providers, active source/formula adoption and open-ended executable strategy generation remain outside the approved bounded adoption contract. This release supplies hypothesis/evaluation capabilities, not permission to silently change sources, invent historical data or route model output into execution. Council/composite replay requires its own retained forecast/time contract rather than being approximated by a dimension score. Live trading remains separately governed.

## Validation

Full application suite: 4,736 passed, eight skipped, 580 test files passed and one skipped. Final targeted replay/collector/continuation suites: 23 passed across five files, including the additional continuation regression. A clean nonincremental TypeScript check passed. The isolated production build succeeded, including all 77 static pages; its generated path changes to tracked TypeScript configuration were restored. GitGuardian found no secrets in staged changes; the oversized work-log file was checked separately using its actual patch. Diff checks passed. Both markets' existing automation remains enabled with one shadow slot; no policy values were changed.

## Release verification

Commit `1033a98267361956f94c23a02c7ade61c7f3caa6` is the exact `origin/main` SHA and the source SHA for Vercel production deployment `dpl_5nchhR5oHscxnorFfmCSnVFscPFU` (READY; alias `financeos-phi.vercel.app`). GitHub acceptance run `41691942472` passed both `application-contracts` and `clean-database-replay`. Production `/login` returned HTTP 200; unauthenticated `/api/strategies/template-shadows?market=us` returned HTTP 401. No strategy/research/watchdog/trade route was manually invoked.

Natural-cycle acceptance and profitable-strategy evidence remain pending. Production still has zero strategy configs/decisions/outcomes, so the next natural weekly Learner and daily Research cycles must prove that discovery attempts persist and forward observations collect. No profitability claim is supported yet.

## Symbol-level evidence view follow-up — 2026-11-05

The owner expected the symbol detail page to show a strategy/backtest for each symbol. The existing approved loop is a bounded, market-local discovery cohort (currently at most ten recently researched names per candidate), not an individual LLM call for every ticker. Added a `Strategy research` tab backed by the existing owner-authenticated strategy-shadow read route with an optional market-validated `symbol` filter. It displays frozen candidate formula/version, symbol decision count, matured and pending labels, net outcomes versus deterministic eligibility, and the candidate's historical screen separately. No matching config, no observations, pending outcomes, and descriptive matured outcomes have distinct labels. It does not trigger discovery or research, alter scoring/trading, or imply ticker-level validation.

Production verification on November 5 found zero shadow configurations, decisions, and outcomes, and zero `strategy_discovery` runs in the prior 30 days. The latest Learner rows were October 30 and predate the November 3 discovery release, so their `0 hypotheses` summaries do not verify the new deterministic discovery producer. The next natural Learner cycle is still required to establish runtime coverage; the next natural Research cycles must then collect ticker decisions/labels. Per-symbol profitability and complete-universe coverage remain unproven.

Implementation verification: focused `strategy-template-shadow-flow-contract` test passed (5/5). `npm run build` completed successfully, including lint/type validation and generation of all 77 static pages. Release, exact-SHA deployment, and natural-cycle evidence remain outstanding at the time this record was updated. Full QI Quant Phase 1 still requires a separately implemented and audited dual-instrument stop/target replay plus sufficient licensed historical data; see `QI_QUANT_GAP_AUDIT_2026-11-05.md`.
