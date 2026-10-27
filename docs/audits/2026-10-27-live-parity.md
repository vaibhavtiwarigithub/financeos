# Live portfolio parity audit — 2026-10-27

Live and paper share partial-exit/runner arithmetic, but deployed code is not
enabled live execution. Production currently reports live_auto_enabled=false,
protective_orders_enabled=false, leveraged_live_auto_enabled=false,
crypto_live_auto_enabled=false and L3_live_manual. No switches changed here.

## Reproduced defect and bounded repair

The Oct27 MARKET_STATUS daily cache was fetched at04:00UTC with US=closed and
India=open. US live-exit producer runs at15:00/16:00UTC incorrectly recorded
outside_market_session. Natural Guardian cron POSTs returned200 but the last
completed account scan remained Sept16. The route's session check precedes scan
claiming. Together these identify the stale corroborator as a real skip cause;
they do not prove account connectivity will succeed after the repair.

The shared market gate now reads payload plus original fetched_at together,
validates a five-minute nonfuture observation lifetime with a post-read clock,
and prevents the memory cache from renewing that lifetime. Stale/missing/failed
provenance uses the documented existing local-session fallback. Fresh closed
still vetoes; quote freshness and broker/account/order gates remain required.
No additional provider calls, schedules, schema or paid services were added.

The existing Guardian owner panel now shows verified live switches and actual
last completed scan date. Missing metadata remains unknown; an empty plan book
does not mean all holdings are protected. No account identifiers are returned.

## Remaining gaps

- Automatic live buy, top-up, rotation and exits are not enabled. A complete
  account capital/loss/duration mandate and all existing execution prerequisites
  are required; paper authorization does not activate live accounts.
- Live managed ladders reconstruct Kairos filled broker orders, not every manual
  position across all connected brokers. Guardian manual detection/protection is
  limited to new manual buys in the approved agentic Robinhood account.
- India Guardian currently reads Kite holdings/GTT coverage; it has no equivalent
  full manual-fill/arming/stop execution lifecycle. Its unavailable Kite source
  requires reconnection. Webull/Alpaca universal stop coverage is not established.
- Broker stop/cancel/partial-fill reconciliation, real protective lifecycle and
  current account/cash/order/quote readiness must be verified before activation.
- Paper ladder charts/history are paper-lot scoped. Live charts need authoritative
  broker/account-scoped fill, original-lot P&L and stop/target change history;
  matching paper histories by symbol would invent live financial evidence.
- Guardian outcome scorecards lack matured, graded stop-advice evidence. No
  demonstrated P&L benefit is claimed.

## Verification

Focused regression tests cover stale/future/missing/failed observation provenance,
fresh closure veto, observation-bounded memory expiry, arrival during fetch,
local closures, and owner-only runtime metadata/unknown reads/no account leakage.
Release and natural scheduled outcomes are recorded in WORK_LOG. Do not manually
invoke a trading-capable cron or broker order to test this repair.
