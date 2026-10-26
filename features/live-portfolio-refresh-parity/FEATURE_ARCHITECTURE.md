# Live portfolio refresh and market parity

## Private-page rendering boundary

The live-portfolio server page is request-rendered (`force-dynamic`), not ISR or
build-time prerendered. Deployments must not fetch private broker snapshots or
depend on database availability to emit this page. This does not repair runtime
database outages or establish broker freshness; existing read-only refresh,
authorization and recorded-data contracts remain unchanged.

## Benchmark display correction — 2026-10-22

This supersedes the older paper-proxy allowance below. The live chart reuses
`BenchmarkPerformanceChart` and `/api/portfolio/performance-series?book=live`,
with owner-only access and the same enabled market-local `benchmarks` choices
and exact-session observation ledger as paper. Display preferences are separate
for each book/market; the governed primary benchmark never changes. Both live
markets use one wrapper, not a second chart/math implementation. Existing live
performance endpoint delegates to this contract; it performs no provider fetch.

Live history is **unadjusted recorded account equity**, not trading performance.
The current ledger records no verified deposits, withdrawals or transfer series.
It therefore cannot establish time-weighted return, alpha or outperformance;
those claims/badges are withheld, with an explicit warning. No flow is inferred
from an equity jump. No paper NAV, primary-only snapshot benchmark, or backcast
from today's holdings substitutes for actual live history.

The account set stays fixed for the selected window. A missing/invalid selected
account invalidates that session instead of becoming a zero balance or using a
stale carry-forward. Explicit empty selection means no accounts. US legacy-null
market/currency rows are US-only; India requires its INR market scope. Reads are
paginated and ordered; benchmark sessions without live observations are gaps,
never interpolated portfolio values. Return arithmetic still rebases both
visible lines over matching observations, but the live line is labelled account-
equity change, not investment return. Freshness and actual coverage dates remain
visible even when insufficient history leaves the chart empty.

No schema, snapshot producer, broker connection, financial record, score, risk
limit or live order is changed. Cash-flow collection and validated end-of-day
valuations are prerequisites for a future true live-return comparison; this
display repair does not claim they are built or recover missing history.

**Status:** Implemented, pushed to `main`, and production-verified (`882563a0cbd18193c5939255f58f35a115af6b48`, 2026-10-19). Read-only broker/account access only. No order, account-routing, safety-threshold, or live-trading changes.

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

October 25 reliability correction: both UI sync handlers reject non-success HTTP
responses before presenting a success message. A completed read-only sync also
reloads the market's Guardian panel; existing coverage cannot remain silently on
its pre-sync reading. Failed plan/holdings/GTT reads show unavailable/unknown,
not an empty or protected portfolio. No order is placed by this refresh.

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

Production verification on 2026-10-19: the deployed US page successfully refreshed Robinhood and Webull read-only snapshots; the India page successfully refreshed Kite holdings and wrote a Kite live-performance point. No orders were placed. Production live-performance currently has only two India points (2026-07-13 and 2026-10-19), so recent windows with fewer than two points correctly keep the labeled paper proxy until fresh daily Kite observations accumulate. The scheduled `kairos-live-snapshot` job is active; Kite's daily access-token lifecycle still requires a valid same-day token for each day's capture.

Production runtime credential/entitlement checks remain separate: local `.env.local` is not a Vercel secret store, and broker account connectivity does not establish a market-data subscription. Do not claim live Alpaca/Webull market data is feeding scores from this implementation.

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
