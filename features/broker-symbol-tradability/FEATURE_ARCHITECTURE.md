# Broker Symbol Tradability Gate — Feature Architecture

**Status:** Stage 0 approved 2026-09-09; shadow implementation and production schema deployed, enforcement remains gated
**Scope:** Every live BUY, SELL, and broker-side protective order
**Behavior today:** Broker-authoritative symbol/side preflights are recorded in shadow mode; they do not yet block or enable orders

## Decision

Kairos must never submit a live order merely because a symbol is syntactically valid or belongs to its research universe. Immediately before the irreversible broker call, it must prove that the exact broker, account, environment, instrument, side, quantity, and order type are allowed.

This is a safety gate, not a research filter. Research may study a wider universe. An approved proposal is still not executable until this gate passes.

## Contract

Extend `BrokerAdapter` with a mandatory preflight method:

```ts
type BrokerInstrumentCapability = {
  broker: string;
  accountId: string;
  env: "paper" | "live";
  market: "us" | "india";
  requestedSymbol: string;
  canonicalSymbol: string;
  instrumentId: string;
  side: "buy" | "sell";
  orderType: "market" | "limit" | "protective_stop" | "protective_target";
  allowed: boolean;
  active: boolean;
  buyAllowed: boolean;
  sellAllowed: boolean;
  closeOnly: boolean;
  fractionalAllowed: boolean;
  lotSize: number;
  tickSize: number | null;
  checkedAt: string;
  expiresAt: string;
  source: string;
  reasonCode: string | null;
  rawFingerprint: string;
};
```

The check is side-specific. A broker disabling new BUYs must not automatically block a risk-reducing SELL. Conversely, a held symbol is not proof that a SELL is currently accepted. If the broker cannot establish the requested side, the app fails closed and directs the owner to act in the broker app.

## Authoritative sources

- Alpaca: `GET /v2/assets/{symbol_or_asset_id}`; require an active matching asset and `tradable=true`, plus account/order constraints.
- Zerodha Kite: the daily instruments master establishes the `exchange:tradingsymbol`, token, lot size, and tick size; a fresh quote key must also exist. The master is refreshed once daily before market open.
- Robinhood: resolve the broker instrument identifier and inspect the instrument/account tradeability response. If the MCP bridge cannot expose this capability, Robinhood live submission remains unsupported through that adapter rather than guessing.
- Future adapters, including Webull, cannot register without implementing this contract and passing the conformance suite.

## Placement in the live path

1. Validate proposal and local symbol policy.
2. Select the exact broker and account.
3. Fetch a fresh broker capability (short TTL; no stale fallback).
4. Validate side, quantity/lot, tick, order type, and session restrictions.
5. Persist immutable preflight evidence tied to the proposal/order intent.
6. Reserve the order atomically only when the reservation RPC receives the same preflight fingerprint.
7. Re-check the fingerprint and capability in the adapter immediately before the wire call.
8. Submit once. An ambiguous response is reconciled, never retried blindly.

Both layers are required: the gateway check gives a consistent refusal and audit record; the last-mile adapter check prevents direct routes or future callers from bypassing it.

## Paths that must be covered

- `lib/trading/execute-order.ts`
- every adapter implementing `lib/brokers/adapter-types.ts`
- `app/api/kite/order/route.ts` (currently bypasses the generic gateway)
- `lib/protective/kite-placement.ts` and Kite GTT placement
- autonomous live entry and live-exit monitor paths
- any future ladder leg, stop, target, replacement, or cancel/replace submission

No exception is permitted for an “urgent” automated exit. If validation infrastructure is unavailable, Kairos alerts the owner to exit directly at the broker; it does not submit an unverified order.

## Persistence and database gate

Add an append-only `broker_instrument_preflights` table with proposal/order linkage and the fields above. Revoke UPDATE, DELETE, and TRUNCATE from application roles; enforce immutability with triggers and tested grants. The live reservation function must reject missing, expired, mismatched, denied, or already-consumed evidence.

This schema and RPC change requires explicit approval and a checked-in migration before production application.

## Tests and rollout

- Adapter conformance tests for unknown, inactive, not-tradable, buy-disabled, sell-disabled, close-only, fractional, wrong lot, wrong tick, delisted, halted, stale, timeout, and symbol-alias cases.
- Mutation test: force each adapter to return `allowed=true`; a denial fixture must fail.
- Static direct-submit inventory test: every broker wire-call site must be registered and guarded.
- Rolled-back database tests for freshness, fingerprint matching, single consumption, RLS, grants, and TRUNCATE denial.
- Shadow for at least 10 market sessions: record would-pass/would-block without changing execution. Investigate every disagreement with actual broker acceptance/rejection.
- Owner review of the shadow report, then a separate approval to enforce on paper, and another explicit approval before live enforcement.

## Explicit non-goals

- This does not broaden the research universe.
- It does not enable Alpaca, Robinhood, Kite, Webull, Coin, or live trading.
- It does not infer mutual-fund availability in Zerodha Coin from Kite equity instruments. Coin needs its own instrument/order contract if it is ever automated.
- It does not allow a cached research-provider symbol list to substitute for broker truth.
