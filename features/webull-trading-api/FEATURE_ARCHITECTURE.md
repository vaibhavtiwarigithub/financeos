# Webull Trading API Adapter

> Status: DRAFT, design only. Not approved or enabled. US live money path.

## Resolved Boundary

Webull exposes two different products:

- **Cloud MCP** is an AI-friendly, query-only surface. Kairos may use it for
  account, position, balance, and quote reads. It has no configured order scopes
  or write tools and `orderCapable` remains false.
- **Trading API** is a separately entitled, signed REST/gRPC integration. It is
  the only candidate for future Webull order placement.

The two transports, credentials, scopes, and registries must never be combined.
The existing `webull` MCP adapter remains read-only. A future trading adapter gets
a distinct id such as `webull_trade`.

## Verified Trading API Facts

- Individual applications require Webull approval and API credentials.
- Access tokens are reusable and expire after the documented inactivity window;
  authentication may require 2FA during token acquisition, not a guessed secret
  pasted into each order.
- Requests use Webull's documented signed authentication protocol, including its
  canonical request and HMAC-SHA1 signature. Do not substitute generic OAuth or
  a vendor SDK assumption.
- Stock order endpoints support market/limit/stop variants, client order ids,
  order query/cancel/replace, and documented rate limits.
- Trailing-stop stock orders are documented with DAY time-in-force only. They are
  not a uniform multi-day replacement for Kairos's cross-broker exit policy.
- Sandbox and production are separate environments and credentials.

Exact fields and limits must be pinned from the current official documentation in
contract fixtures immediately before implementation because this is a live broker
surface and may change.

## Recommendation

Do not enable Webull trading now. Build only after the existing paper and live
decision loops, router cutover, and protective-order policy are stable. When built:

- Webull is an additional US live venue, not a new strategy.
- Deterministic Kairos logic remains authoritative.
- Native trailing stops stay out until a separately versioned strategy experiment
  proves broker-dependent exit semantics are acceptable.
- Long-only is enforced in both the gateway and adapter; `SHORT` is rejected.

## Credential and Transport Design

- Store production and sandbox credentials as separate encrypted vault records.
- Never expose app secret, access token, refresh material, account id, signature,
  or canonical request in logs, errors, UI, or model context.
- Fetch credentials through a server-only accessor with bounded in-memory caching.
- Pin endpoint environment to the credential record. A sandbox credential can
  never resolve a production host.
- Implement the official signing algorithm directly with golden fixtures from the
  documentation. Redact before any telemetry boundary.
- Use a bounded timeout and retry only requests proven idempotent.

## Adapter Contract

Create a distinct `webull_trade` adapter implementing:

- account discovery and exact allowlist match
- position, cash, buying-power, order, and fill reconciliation
- preview when supported by the entitled surface
- place, query, modify, and cancel with a stable `client_order_id`
- normalized partial-fill and unknown-state handling
- provider rate-limit classification and health reporting

It writes only through the existing execution kernel and execution ledger. It may
not create a parallel trade, cash, position, or P&L store.

## Mandatory Gate Ladder

Every order requires all gates in this order:

1. Global trading enabled and app not paused.
2. US market control enabled and kill switch clear.
3. Drawdown/circuit breakers clear; exits remain possible when entries halt.
4. Live autonomy/approval mode satisfied.
5. Exactly one enabled Webull trading account allowlisted for US.
6. Explicit `webull_trade_orders_enabled` false-by-default feature flag.
7. Valid non-expired production credential and expected endpoint.
8. Existing buying-power, notional, name, sector, gross, turnover, and duplicate
   order checks.
9. Deterministic quantity no greater than the reconciled mandate allowance.

Missing schema, config, account, credential, or broker response fails closed.

## Order Lifecycle

1. Reserve an execution intent using the existing idempotency mechanism.
2. Reconcile account and held quantity immediately before submission.
3. Build a normalized order and reject short/options/unsupported sessions locally.
4. Sign and submit once with a stable client order id.
5. A timeout or response without an order id becomes `needs_reconcile`; never
   report success and never blindly resubmit.
6. Reconcile order status and fills until terminal.
7. Update the existing execution and position truth using actual fills.

## Failure and Security Tests

1. Cloud MCP configuration contains no write scope or order tool.
2. Every missing gate blocks before network submission.
3. Two allowlisted accounts fail closed as ambiguous.
4. `SHORT`, options, and unsupported order/session combinations are rejected.
5. Sandbox credentials cannot call production and vice versa.
6. Official signature fixtures match exactly; mutated method/path/body fail.
7. Secret capture assertions cover logs, errors, traces, and health events.
8. Reusing a client order id cannot create a second order.
9. Timeout and malformed response enter reconciliation, not retry-to-place.
10. Partial fills and external cancellations preserve correct held quantity.
11. US pause, kill, drawdown, approval, and notional gates are regression-tested.
12. India state is unreachable from the adapter.

## Open Owner Decisions

1. Does Webull replace Robinhood for US live execution or remain an optional
   second venue? Recommendation: optional manual venue first; no automatic routing.
2. Which approved individual Webull account is allowlisted?
3. Is the required Webull API entitlement active for that account?
4. After sandbox proof, authorize one manually approved minimal live order?

## Build Order After Approval

1. Confirm entitlement and capture current official schemas/rates/signing fixtures.
2. Add vault records and secret-hygiene tests.
3. Build read/reconciliation in sandbox with no place permission.
4. Build signed order operations behind all gates, still disabled.
5. Run fault injection and full money-path regression tests.
6. Owner reviews sandbox ledger and explicitly approves one minimal live test.
7. Keep autonomous Webull routing disabled until a separate production sign-off.
