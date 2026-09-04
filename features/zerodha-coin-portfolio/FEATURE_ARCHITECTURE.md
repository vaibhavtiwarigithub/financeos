# Zerodha Coin portfolio sleeve

Status: APPROVED by owner (`go`, 2026-09-03)

## Decision record

- **Why:** Kairos currently omits the owner's Coin mutual-fund assets, understating the visible India portfolio and hiding fund concentration.
- **Who:** The single owner using the existing Zerodha Kite Connect session.
- **ROI:** Complete read-only India account visibility without expanding the trading or stock-scoring surface.
- **Shipped at:** 2026-09-03 (code complete; live account read awaits the owner's next Kite login because the stored daily token is expired).

## Scope

Use the existing daily Kite access token to read `GET /mf/holdings`. Normalize the response into a separate Coin contract and return it alongside the existing equity portfolio response. Show Coin funds, latest available NAV date, invested value, current value, P&L, and their share of invested India assets on the existing India Live Portfolio page.

The existing `nav` field remains equity cash plus equity holdings for compatibility. A new `combined_nav` is returned only when equity NAV exists and every Coin holding has a usable latest NAV. Coin endpoint failure is distinct from a successful empty account.

## Non-goals

- No mutual-fund purchase, redemption, SIP, or other order endpoint.
- No Coin holding enters ResearchAgent, stock scoring, entry eligibility, stops, targets, ladders, or live/paper equity performance.
- No constituent look-through, category benchmark, historical NAV reconstruction, or fund recommendations in this version.
- No database schema or persisted credential change.
- No claim that the Upstox/NSE equity universe is the Zerodha or Coin instrument master.

## Contracts

`lib/brokers/coin.ts` owns deterministic parsing and aggregation. Invalid quantities are rejected. Missing NAV or cost stays `null`, never zero-filled. A successful response with any unvalued holding has `valuation_complete=false`, `total_value=null`, and cannot produce `combined_nav`.

`GET /api/kite/portfolio` remains owner-gated and adds:

```ts
coin: {
  available: boolean;
  holdings: CoinHolding[];
  holding_count: number;
  valuation_complete: boolean;
  total_invested: number | null;
  total_value: number | null;
  total_pnl: number | null;
  error?: string;
};
combined_nav: number | null;
```

## UI and failure states

The existing full-width India Live Portfolio page gets a separate read-only Coin section. It distinguishes loading, reconnect/unavailable, successful empty, complete valuation, and incomplete valuation. Money remains privacy-mask aware. Fund rows use wrapping cards rather than a wide mobile table.

The page states that Coin NAV is end-of-day/last available and that existing performance, risk, research, and order controls remain equity-only.

## Acceptance criteria

1. The same fresh Kite session reads both equity and Coin holdings.
2. Coin failure never blanks equity holdings or changes the legacy equity `nav`.
3. Empty Coin holdings are not reported as a connection failure.
4. Missing NAV prevents combined totals rather than becoming zero.
5. No Coin write endpoint or order control exists.
6. Parsing tests, API contract tests, full test suite, typecheck, and production build pass before shipping. Owner-authenticated live-data verification is recorded after the next Kite login; an expired daily broker token is reported as unavailable and never fabricated as an empty Coin account.
