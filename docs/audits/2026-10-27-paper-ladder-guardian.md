# Paper ladder and Guardian review — October 27, 2026

## Paper ladder

Read-only enhancement of the existing US/India chart. Reconciled share steps remain separate from per-share prices inside one time-aligned graphic. Buy/sell markers show exact quantity, fill and notional; sale markers show gross lot-realized P/L and the details list preserves every event. Buys realize no P/L. Tainted sale lots remain unknown. Exit timestamps before the lot's entry are refused.

The current stop and target appear in the same graphic and in text. Historic stop/target changes were never fully retained; current levels are not backdated, and the UI states that explicitly. Prospective complete event capture is proposed in the existing architecture, with a pending explicit schema-approval question. No new table/trigger is applied before approval. No trades, historical records, policy, funds or broker configuration are changed.

## Guardian — production evidence, not completion claims

Read-only owner requests on October 27:

- US `GET /api/manual-trade-guardian/plans`: HTTP 200, zero plans. Database plan status aggregation also empty. `live_auto_enabled=false`, application not paused/security-locked. Thus no active Guardian software-stop coverage can be claimed from this plan ledger.
- US scan-state evidence is stale: last completed September 16 20:00 UTC, despite an active 15-minute schedule and scheduler dispatches marked succeeded on October 26. The dispatcher only queues HTTP work; that success is not route completion. No unresolved `manual-trade-guardian:*` issue was present in the current alert ledger. Root cause and natural end-to-end scan confirmation remain pending. A new scan is not manually invoked because this route can execute armed protection plans.
- India `GET /api/live-portfolio/india-guardian`: HTTP 503; holdings and GTT unavailable. Response explicitly says coverage unknown and asks to reconnect Kite if expired. This is not a verified empty book.
- US recommendations: HTTP 200; one legacy/ungraded stop suggestion, zero evaluated at h2/h5/h10/h20, zero plan events. Last evaluator timestamp October 26 22:30 UTC.
- India recommendations: HTTP 200; zero stored stop suggestions and zero evaluated outcomes; no evaluator timestamp for that empty cohort. Existing broker GTTs are not counted as app-generated advice.

## Pending Guardian queue

1. Restore Kite authentication/authoritative holdings and GTT coverage. Owner connection/session action is required; never treat unavailable as empty or protected.
   Diagnose the stale US scan separately: inspect dispatcher HTTP outcome, route authentication/calendar/account-read failure and missing freshness reporting. Restore the existing approved producer and verify a natural session; do not infer health from the queue's success. The current manual-fill workflow also does not establish protection coverage for every pre-existing held symbol.
2. Complete the account-specific outer live mandate and activation prerequisites before any automatic protective execution. No current US plans, live switch off, and a real protective stop/cancel/fill lifecycle remains unproven. Arming is not execution and a suggestion is not a broker stop.
3. Full India manual-fill detection/attribution, stop-advice producer, approval/arm/monitor/reconcile lifecycle remains unbuilt. Current panel is read-only holdings/GTT coverage. Kite GTT child-limit behavior needs its own execution design/evidence.
4. Webull/Alpaca Guardian execution parity and complete all-account protection remain unbuilt; live holdings display/research integration does not deliver protective orders.
5. Measurable Guardian performance needs prospective versioned stop suggestions, exact quantity/cost/fill lineage and matured paired stop-versus-hold outcomes. The current scorecard has no evaluated evidence and cannot establish a benefit.
6. Regime-adaptive loss/recovery/re-entry ladders remain a proposal (`docs/research/live-holding-loss-review.md`); no automatic averaging-down policy or superior recovery result is established.

Related live-portfolio limitation: verified cash-flow history is still needed for true live investment return versus benchmarks. This is separate from Guardian stop coverage and from the read-only paper ladder.

## Verification

24 focused tests and TypeScript/secret scans passed. The full run passed 4,510 tests with eight skipped and one unrelated parallel performance timeout; that isolated performance test passed in 4.79 seconds (all 4,511 checked tests passing across verification). Runtime commit 6383779940e563a153de5b3c06759c25445c43d2 matched remote main and production dpl_7vfLWebjYyk9cBQSGrvwKV6bj8SR was READY. Live API200 and owner UI verified six US and eight India reconciled ladders, four real US sale events, correct currency/current levels and expandable event details. No overflow at375/768/1440; zero console errors. A browser-only negative-P/L fixture passed and was removed; actual data restored. No production financial writes, broker order actions, trading-cron invocations or extra model calls are used to test this feature.

## Approved follow-up completed

After this review, the owner approved prospective history capture. It is now applied and production verified; see 2026-10-27-paper-plan-history.md for migration, security, atomic SQL proof and live US/India reader evidence. Earlier stop/target changes remain unknown. This resolves the history-table approval/capture item above; it does not resolve the separate Guardian queue.
