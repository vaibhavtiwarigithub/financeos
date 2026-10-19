# Live portfolio refresh and market parity

**Status:** Implemented locally; production release pending. Read-only broker/account access only. No order, account-routing, safety-threshold, or live-trading changes.

## Goal

Make the US and India live portfolio pages describe the same operational facts clearly while preserving their different broker contracts and currencies. A user-requested refresh must actually ask configured read-only broker connectors for a new snapshot; a reload must not be presented as a broker sync. India delivery holdings and same-day positions must be visible as separate datasets and must never be added together without a defensible NAV rule.

## Existing owners to reuse

- Refresh orchestration and snapshot writers: `app/api/live-account/refresh-snapshot/route.ts`.
- US snapshot reader: `app/api/live-portfolio/route.ts` and `live_account_snapshots`.
- India direct reads: `app/api/kite/portfolio/route.ts` and the functions in `lib/kite.ts`.
- Live benchmark accrual: `live_performance`; Kite writes market=`india`, currency=`INR`, broker=`kite` and US accounts remain separate.
- Existing broker issue lifecycle: `lib/system-health.ts`.
- Existing US/India portfolio UI: `LivePortfolioPage`, `IndiaLivePanel`, and shared `LivePerformanceChart`/`LiveStatCards`.

## Contract and safety rules

1. Existing scheduled refresh remains cron-authenticated. Manual refresh is separately owner-authenticated and calls the same read-only orchestration. It never calls broker order endpoints.
2. A broker's failed, incomplete, or disconnected read never overwrites its last good persisted snapshot. A per-broker failure must not prevent other broker refreshes.
3. The UI reports when data was fetched, when the last saved snapshot was captured, and any per-broker refresh result. “Reload” and “Sync from broker” are distinct actions.
4. Robinhood, Webull, and Alpaca US accounts can appear in the US account rollup only when their own account snapshot has been successfully captured. Same-currency totals are display aggregation, not order-routing authority. Kite remains in the India page and INR-only.
5. Kite `portfolio/holdings` (delivery/custody holdings) and `portfolio/positions` (day/net trading positions) remain visibly separate. Same-day position data is not summed into delivery holdings, Coin, or chart NAV, avoiding double-counting.
6. The India chart remains explicitly a forward-built live series. Until at least two live market-local daily observations exist, its existing labeled paper proxy is correct; do not fabricate historical live NAV from today's holdings.
7. Failed configured refreshes create/update the existing deduplicated System Health issue; a verified successful refresh resolves it. An intentionally disconnected provider is not a health failure.
8. Alpaca/Webull/Robinhood market-data feeds are not added to deterministic scoring merely because broker account access works. Provider data must have a configured production credential/entitlement, explicit venue/feed provenance, a source timestamp, freshness validation, and a safe fallback policy. Alpaca's local `.env.local` credentials do not configure Vercel. Webull account MCP is not Webull's separate Market Data OpenAPI entitlement.

## Implementation slice

- Permit owner-triggered read-only refresh through the existing orchestrator while keeping the cron guard.
- Add Kite day-position reads and an independently labeled section to India Live.
- Add explicit refresh state/result and latest-snapshot timestamp to both pages.
- Surface failed configured refreshes using the existing System Health reporter.
- Clear snapshot-failure alerts when an optional broker is intentionally disconnected, while leaving broker-connection health to its own issue lifecycle; redact provider secrets from UI/API error details.
- Add regression tests for auth boundary, read-only behavior, independent broker failures, market/currency scoping, and non-overlapping Kite views.

## Local verification

- `npx vitest run tests/kite-coin-portfolio.test.ts tests/live-portfolio-refresh-parity.test.ts`: 10 tests passed.
- `npx tsc --noEmit`: passed.
- Full repository suite in this task: 3,989 passed, 7 skipped. The final follow-up only changed disconnected-provider health reconciliation and response-error redaction; the two directly affected test files were rerun afterward.
- `git diff --check`: passed; Git reports only the repository's existing LF/CRLF normalization warnings.

## Release boundary

These edits are local and have not been pushed or deployed. Production runtime credential/entitlement checks remain separate: local `.env.local` is not a Vercel secret store, and broker account connectivity does not establish a market-data subscription. Do not claim live Alpaca/Webull market data is feeding scores from this implementation.

## Explicitly not claimed complete

- A historical backfill of actual broker NAV (neither Robinhood nor Kite provides it through these account reads).
- Consolidated market-data entitlement for Alpaca SIP or Webull OpenAPI. Alpaca IEX is a distinct feed; Webull MCP account reads are not market-data API credentials.
- Trading readiness, Guardian protection, broker order parity, or live order submission.

## Acceptance checks

- Owner-only manual refresh; unauthenticated request is rejected; scheduled cron-secret path still works.
- No broker order function is reachable from refresh orchestration.
- Each broker refresh reports success/failure independently, preserves prior snapshots on failure, and has no cross-market/currency aggregation.
- Kite day positions render separately from delivery holdings and never change NAV, Coin totals, or order controls.
- TypeScript and focused tests pass; production deployment and live provider credentials are not inferred from local tests.
