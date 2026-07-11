# FinanceOS US/India Pipeline Verification and Remediation — 2026-07-11

## Executive verdict

The application builds, deploys, authenticates its scheduler, and the US/India research and paper paths have recent successful production runs. This review found and fixed several material failures that prevented the production system from matching its architecture. The platform is safer and the learning dataset is now advancing, but it is **not yet evidence-proven to beat the market** and should not be described as fully self-evolving: there are still too few matured outcomes for champion/challenger promotion, and no real-money end-to-end order was submitted during this review.

## Critical/high issues fixed

| Severity | Area | Production failure | Fix | Verification |
|---|---|---|---|---|
| CRITICAL | Scheduler security | Migration 157 committed a live cron bearer credential and stored it in `cron.job.command`. | Revoked and rotated the credential; removed it from migration 157; migration 159 reschedules live-exit and stale-check through Vault-backed `kairos_call_agent`. | Production cron commands contain no bearer literal and use the Vault caller. Public stale-check returns 401; the authenticated cron call returns 200. |
| HIGH | Stale-check authorization | Public GET used the Supabase service-role client and could create alerts/journal rows. | Owner-or-cron authorization on GET/POST; pg_cron and PowerShell now use authenticated POST. | Unauthenticated production request returns 401. |
| HIGH | Learning pipeline | `observation_labels` remained at zero because US label maturation only queried an empty `price_cache`. | Provider fallback (Massive → EODHD → Twelve Data), cache persistence, and per-run candle memoization. | A production maturation run created 45 labels (`matured=45`, `skipped=26`). |
| HIGH | Multi-market learner | `learner_runs.run_date` was globally unique, so US and India runs collided/overwrote each other. | Migration 159 adds `market`, backfills US, and enforces `(run_date, market)` uniqueness; all learner queries/upserts are market-scoped. | Applied in production; column and unique index exist. |
| HIGH | Learner reliability | Weekly US and India learner runs were reaped without finalizing; the route had a 60-second cap and cron had a 70-second timeout. | Route `maxDuration=300`; both pg_cron jobs use 290-second timeouts. | New schedules are applied; the next Friday run remains the operational soak test. |
| HIGH | Insider correctness/quota | Markets used five scarce Alpha Vantage calls per cache refresh/build and treated acquired/disposed codes as open-market buys/sells. | Markets now combines official SEC Form 4 data with the congressional feed; only transaction codes P/S count as open-market buy/sell; display reads no longer append duplicate evidence. | Production build no longer calls Alpha Vantage insider endpoints. |
| HIGH | Supabase view security | `v_decision_quality` and `provider_budget_7d` ran with view-owner privileges; one SECURITY DEFINER RPC had a mutable search path. | Migration 160 sets both views to `security_invoker` and pins `get_daily_ai_count(uuid)` to `public, pg_temp`. | Migration applied in production. |
| MEDIUM | Agent health attribution | Paper-trader runs did not record market, making US/India health checks ambiguous. | `agent_runs.market` is now written from `?market=` and stale-check includes both market schedules. | Typecheck/build pass; next weekday cron is the soak verification. |
| MEDIUM | Scheduler time math | Stale-check used approximate month-based ET offsets and incomplete job coverage, producing false/missed alerts around DST and India jobs. | Compare directly against the deployed UTC pg_cron schedule; added India paper/learner coverage and canonical recovery endpoints. | Production route deployed and authenticated. |
| MEDIUM | Dependency security | `next-pwa` pulled five high-severity Workbox/serialization advisories even though PWA was disabled. | Removed unused PWA wrapper/dependency, upgraded Next to 15.5.20, pinned PostCSS 8.5.16. | `npm audit --omit=dev`: 0 vulnerabilities. |

## Production evidence reviewed

- Latest US research: 42 signals, 0 failures (2026-07-10).
- Latest India research: 8 signals, 0 failures (2026-07-10).
- Paper pipeline has US and India fills and market-separated NAV; recent runs were successful but several signals were legitimately skipped by gates.
- Decision observations: 173 US and 37 India at review time.
- Before remediation: 0 observation labels, 0 shadow decisions, 0 model artifacts. After remediation: 45 observation labels.
- Historical observations have null `evidence_confidence` because they predate the deployed scoring upgrade. New research runs must be checked for non-null confidence; append-only history was not rewritten.
- Recent US/India position-monitor alerts showed missed runs on July 10. The scheduler URL was corrected previously and stale detection is now accurate, but the next trading-day run is still required as an operational soak check.

## Validation completed

- `npx tsc --noEmit` — pass.
- Vitest — 34 files passed, 1 skipped; 281 tests passed, 6 skipped.
- `next build` on Next 15.5.20 — pass.
- `npm audit --omit=dev` — 0 vulnerabilities.
- Two production Vercel deployments succeeded; canonical alias remains `https://financeos-phi.vercel.app`.
- Supabase migrations 159 and 160 applied to project `dionkikgdmlaotvtbnfr`.
- No live or paper order was submitted as part of this review. The only manually invoked agent job was advisory label maturation.

## Remaining gates before autonomous live trading

1. Accumulate enough point-in-time labels per market/setup/horizon to run walk-forward validation. Forty-five labels are a start, not proof of edge.
2. Produce shadow decisions and model artifacts, then demonstrate net-of-cost out-of-sample improvement with controlled champion/challenger promotion. Both were zero at review start.
3. Soak the next full weekday schedule: India research → paper → monitor and US research → paper → monitor; verify non-null `evidence_confidence` on new observations and no stale alerts.
4. Run broker sandbox/canary acceptance tests for Robinhood and Kite, including partial fills, duplicate requests, reconciliation, kill-switch cancellation, protective exits, stale quotes, and currency caps. Do not use real capital merely to test plumbing.
5. Keep autonomous-live disabled until the above evidence exists. Profitability cannot be guaranteed in every market regime; the correct target is positive, statistically defensible net expectancy with bounded drawdown and reliable abstention.

## Architecture score after fixes

| Dimension | Score / 10 | Reason |
|---|---:|---|
| Execution safety | 8.0 | Unified gated paths and kill switches exist; broker canary/partial-fill proof remains. |
| US/India separation | 8.0 | Currency, market pools, schedules, and learner history are separated; next-run soak remains. |
| Data integrity | 7.5 | Point-in-time observations and append-only evidence exist; historical confidence is missing and provider coverage must be monitored. |
| Research/scoring | 7.0 | Multi-dimensional deterministic scoring is materially stronger, but predictive power is not yet established out of sample. |
| Learning/evolution | 5.5 | Label creation now works, but shadow decisions/artifacts and promotion evidence are not yet present. |
| Operability | 7.5 | Cloud schedules, watchdog, alerts, and health logs exist; missed-monitor history and DST schedule policy need soak/maintenance. |
| Security | 8.0 | Credential rotation, authenticated service routes, invoker views, and zero dependency advisories; broader API-route regression tests remain desirable. |
| Market-beating evidence | 2.0 | Too little matured, out-of-sample, net-of-cost performance to claim an edge. |

**Overall engineering readiness: 7.2/10. Autonomous-live readiness: 4.5/10. Proven market-beating readiness: 2/10.**
