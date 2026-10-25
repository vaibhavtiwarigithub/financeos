# Guardian and live holding-risk source audit

## Owner request

Guardian should follow symbols actually held in connected live accounts, not the
paper portfolio or the research/watchlist universe.

## What the implementation does

- US manual-fill detection fetches broker holdings and compares quantities for
  the permitted agentic Robinhood account. A manual-buy suggestion comes from a
  real position transition, not a researched candidate. Owner-armed software stops
  still require all existing live-execution gates.
- India's read-only Guardian coverage route fetches current Kite delivery holdings
  and compares each with the broker's active GTT book. A failed holdings read is
  unavailable, not an empty or protected portfolio. This is not an intraday-position
  monitor or an automated India stop-placement lifecycle.
- Daily per-holding risk is advisory. It now admits only Robinhood live holdings,
  Alpaca live positions and identity-verified Kite holdings in their own markets.
  It does not create protection plans for all accounts. Webull research capability
  alone is not a connected, authoritative Webull holdings adapter.
- Recommendations include separate **buy ideas**, which intentionally can concern
  symbols not held. These must not be interpreted as Guardian-held positions.

## Reproduced defect and repair

The daily live-risk collector used the mixed `fetchAllAccounts` helper. That helper
also reads internal paper and Alpaca paper portfolios. In India it could claim an
internal-paper run even when live Kite identity verification failed.

Three mocked regression tests failed against the old route, reproducing both
markets' simulated-account admission and the India fallback. The route now calls
the existing Alpaca adapter in live mode directly and does not fetch simulated
books at all. The mixed helper remains unchanged for intentional paper-risk views.
Historical snapshots are preserved; future collection has the corrected scope.

## Verification and limits

Focused tests: **80 passed across five files**, covering live-only route admission,
holding-risk calculations, manual-fill detection, Guardian decisions and India GTT
coverage. The route-admission fixtures stop at mocked claims: no real broker call,
model inference, database write or order is used as a test. TypeScript passed.
Full suite: **533 test files passed, one skipped; 4,426 tests passed, eight skipped,
zero failures**. Secret scans and `git diff --check` passed. The QA/shipping
skills governed bounded checks and release verification; no visual/UI change
was made, so no authenticated visual result is claimed.

No schema, credentials, accounts, stops, formulas, risk limits, live flags or trading
permissions changed. No production collector was manually invoked; the next natural
scheduled collection must demonstrate the new source scope in persisted runs.
This repair does not imply automated Guardian coverage for all connected brokers.
