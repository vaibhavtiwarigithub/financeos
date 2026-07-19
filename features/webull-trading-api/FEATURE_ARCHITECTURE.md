# Webull Trading API Adapter

> Status: transport implementation approved 2026-07-19; disabled and not approved for activation. US live money path.

## 2026-07-19 Transport Restoration Decision

The signed HTTP sender may be implemented now, but remains unreachable from the
broker registry and must not make a real request during build or test. The
activation flag stays false and the adapter continues to report unconfigured.

The current `api_key_vault` schema has no environment column. Environment
isolation therefore uses three distinct key names per environment under
`provider='webull_trade'`: `WEBULL_TRADE_<ENV>_APP_KEY`,
`WEBULL_TRADE_<ENV>_APP_SECRET`, and `WEBULL_TRADE_<ENV>_ACCESS_TOKEN`. This is
the existing vault convention and avoids an unapproved schema migration.

There is one network implementation and two capabilities over it:

- A one-shot **preflight permit** reads and requires the false-by-default database feature flag and
  can call only the official token-check, account-list, or order-preview paths.
  It cannot place, query, or cancel an order. This resolves the unavoidable
  ordering dependency: live token status must be known before gate 7 can pass.
- A one-shot **order permit** is created only from a full `GateSnapshot` for which
  all nine gates pass. It permits only the fixed order endpoint allowlist and is
  consumed by the first request, preventing stale gate clearance from becoming a
  reusable transport handle.

The current hardcoded account gate names the production account only, so order
permits are production-only. Sandbox token/account/preview proof is supported,
but a sandbox place/cancel proof remains blocked until its exact test account has
a separately approved allowlist gate; production account identity must never be
reused as a proxy for a sandbox account.

Both capabilities use the same `liveWebullTransport()` sender and the same sole
`fetch` call. Environment and host are pinned to the credential; signing uses the
hostname without the URL scheme, as required by Webull. Every request gets a new
nonce and timestamp, a 10-second default timeout, the exact signed body bytes,
and `x-access-token`. HTTP and network failures return fixed, redacted
`TransportResult` errors and never throw credential material.

The official token-status endpoint is `POST /openapi/auth/token/check`, not the
previously proposed `GET /openapi/trade/token/query`. A successful `NORMAL`
response produces the fresh `WebullTokenRecord` consumed by gate 7. No keepalive
schedule is added.

### Sandbox proof sequence (not yet authorized)

1. Provision sandbox-only vault keys and keep the production keys absent.
2. With the database feature flag enabled only for the supervised proof window,
   call token-check, then `GET /openapi/account/list`. Pass only if status is
   `NORMAL`, exactly the expected test account is returned, and no production
   account identifier appears.
3. Call `POST /openapi/trade/order/preview` with a one-share US equity limit
   fixture. Pass only if the broker accepts the account/order shape and returns a
   non-mutating estimate.
4. Add a separately approved exact sandbox-account gate before enabling any
   sandbox place/cancel capability. The production account constant is not valid
   proof of sandbox identity.
5. With owner approval, submit one non-marketable one-share limit order that is
   inside Webull's accepted price bands, query it, cancel it, and query the
   terminal state. Do not use `$0.01`: a broker price-band rejection proves only
   rejection handling, not place/query/cancel reconciliation.
6. Pass only if one client order id maps to one broker order, no fill occurs, the
   cancel becomes terminal, the audit/reconciliation record is complete, and no
   secret appears in logs. Any timeout or unknown state stops the sequence for
   reconciliation; it is never resubmitted.

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
- Access tokens are reusable; 2FA (when enabled) is verified via the Webull app
  ONCE at token acquisition, NOT a secret pasted into each order — so autonomous
  cron execution is technically feasible (owner Q1 RESOLVED).
- The official token lifecycle documents `INVALID` after **15 consecutive days
  without an API call**, `EXPIRED` when initial verification is not completed
  within 5 minutes, and reusable `NORMAL` tokens. Kairos tracks the last confirmed
  authenticated call, checks token status before order activity after an idle
  interval, and alerts before the 15-day boundary. It must not generate meaningless
  keepalive traffic merely to hide an unused credential. Invalid, expired, or
  unknown status fails closed before submission.
- Requests use Webull's documented signed authentication protocol, including its
  canonical request and HMAC-SHA1 signature. Do not substitute generic OAuth or
  a vendor SDK assumption.
- Stock order endpoints support market/limit/stop variants, client order ids,
  order query/cancel/replace, and documented rate limits. The Trading API also
  documents richer types — GTC stop-market/stop-limit, OTO/OCO/OTOCO, attached
  take-profit/stop-loss, fractional, extended/overnight sessions, and TWAP/VWAP/POV
  algos. **Documented ≠ in scope.** These are pinned to fixtures only if/when a
  later phase needs them; the initial adapter must NOT expose them.
- **Initial order-type scope (locked small):** market + limit for manual-approved
  entries, and **GTC `STOP_LOSS` in `CORE` as the disaster floor only** (the hybrid-stop
  feature). OCO/OTOCO come only after the basic place/query/cancel/reconcile
  lifecycle is proven. Trailing stops, shorts, options, algos, and automatic venue
  routing are excluded outright.
- Trailing-stop stock orders are documented with DAY time-in-force only — they
  cannot rest multi-day, so they are NOT a substitute for Kairos's exit policy and
  stay out (adopting broker-native trailing would also make exits vary by venue and
  contaminate the Learner — see `features/hybrid-stop`).
- Webull fills the conditional `BrokerProtectiveCapabilities` matrix from
  `features/hybrid-stop`. Initial fixtures declare only US equity `SELL` protection
  using GTC `STOP_LOSS` in `CORE`. The generic presence of `ALL`/`NIGHT` sessions
  elsewhere in the API does not prove a stop order can trigger there.
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
  documentation. Enforce TLS, timestamp skew, and a fresh nonce per request;
  redact the canonical request before any telemetry boundary because it can contain
  account and order data even when the secret itself is absent.
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

The current `lib/brokers/adapters/webull.ts` is an inert scaffold for MCP-derived
order tools that do not exist. During implementation it must be deleted or replaced,
not enabled and not left as a second Webull order adapter. The read-only Cloud MCP
registry may remain under `webull`; signed execution uses only `webull_trade`.

## Mandatory Gate Ladder

Every order requires all gates in this order:

1. Global trading enabled and app not paused.
2. US market control enabled and kill switch clear.
3. Drawdown/circuit breakers clear; exits remain possible when entries halt.
4. Live autonomy/approval mode satisfied.
5. Exactly one enabled Webull trading account allowlisted for US.
6. Explicit `webull_trade_orders_enabled` false-by-default feature flag.
7. Valid `NORMAL` production token when 2FA is enabled, valid signing credential,
   expected endpoint, and acceptable timestamp skew.
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
13. A token idle for 15 days, unknown token status, timestamp replay, or nonce reuse
    blocks before order submission.
14. GTC `STOP_LOSS` is rejected outside the exact session/product combinations
    proven by current contract fixtures.

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

## Primary Sources

- Authentication and reusable 2FA token overview: https://developer.webull.com/apis/docs/authentication/overview/
- Token lifecycle and 15-day inactivity rule: https://developer.webull.com/apis/docs/authentication/token/
- Stock order lifecycle, types, TIF, and sessions: https://developer.webull.com/apis/docs/trade-api/stock/
- Cloud MCP query-only tool inventory: https://developer.webull.com/apis/docs/AI-friendly-Resources/mcp/
