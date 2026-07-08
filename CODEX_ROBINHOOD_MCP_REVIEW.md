# Codex Review — Robinhood MCP Live-Trading Integration

Date: 2026-07-07  
Scope: Robinhood MCP real-money live trading path, OAuth/token handling, Execution Gateway, broker adapter, account allowlist, and related agent-system audit fixes.

## Summary

Do not enable real-money Robinhood MCP order execution yet.

The implementation is directionally correct in its main architecture: LLMs generate research/proposals, and deterministic server code is supposed to execute approved orders. However, several current defects can still place wrong orders, bypass the Robinhood MCP kill switch, allow duplicate submission after ambiguous timeouts, or route orders through the wrong broker/account.

The most important fixes are:

1. Remove generic schema aliasing for `place_equity_order`; pin and verify Robinhood’s actual schema.
2. Enforce `robinhood_mcp_enabled` on the live order path, not only snapshot refresh.
3. Preserve `needsReconcile` and block retry after possible-success timeouts.
4. Owner-gate all trading settings routes.
5. Validate SELL eligibility against the active trading account, not the read-only/manual account snapshot.
6. Fail closed on broker-selection config errors in the order path.
7. Implement real single-writer token refresh.

---

## Findings

### 1. CRITICAL — Schema-based order arg mapper can emit a valid but semantically wrong real order

| Field | Details |
|---|---|
| File | `lib/robinhood-mcp.ts` |
| Location | `buildArgsFromSchema()`, around lines 250-277 |
| Issue | The function maps canonical app order fields to Robinhood MCP tool fields using loose aliases. It checks whether required fields are present, but it does not validate field meaning, units, enum values, or descriptions. |

Problematic logic:

```ts
const alias: Record<string, string[]> = {
  symbol: ["symbol", "ticker", "instrument", "instrument_symbol"],
  side: ["side", "transaction_type", "direction"],
  qty: ["quantity", "qty", "shares", "amount"],
  type: ["order_type", "type"],
  limitPrice: ["limit_price", "price"],
  account: ["account_number", "account", "account_id"],
  timeInForce: ["time_in_force", "tif"],
};
```

Concrete failure scenario:

- Kairos proposal says: buy `10` shares of NVDA.
- Robinhood schema has a required field named `amount`.
- The mapper treats `amount` as equivalent to share quantity and sends `amount: 10`.
- If Robinhood interprets `amount` as dollar notional, the app places a $10 order instead of 10 shares.

Another failure scenario:

- Robinhood schema uses `transaction_type` but expects `"BUY"` / `"SELL"` or `"B"` / `"S"`.
- The mapper sends lowercase `"buy"` / `"sell"`.
- If Robinhood accepts or coerces the value unexpectedly, this can result in a wrong or rejected order.

Why this is dangerous:

This is the final real-money order payload. Failing closed on missing fields is not enough. A filled field can still be semantically wrong.

Fix:

- Do not use generic alias mapping for `place_equity_order`.
- Fetch `tools/list` during connection/setup and pin the reviewed schema shape.
- Store/compare a stable schema fingerprint before live trading.
- Create a Robinhood-specific adapter with explicit mapping:
  - exact account field name
  - exact symbol field name
  - exact side enum
  - exact share quantity vs dollar amount semantics
  - exact order type enum
  - exact time-in-force enum
- If schema fingerprint, required fields, enum values, or descriptions change, block live trading until reviewed.
- Parse `review_equity_order` output and verify the broker’s preview exactly matches:
  - account number
  - symbol
  - side
  - quantity or notional
  - order type
  - limit price, if any
  - time in force
- Only call `place_equity_order` after the review response confirms the same order.

Recommended implementation pattern:

```ts
function buildRobinhoodPlaceEquityOrderArgs(schema: ToolSchema, order: CanonicalOrder) {
  const schemaHash = hashSchema(schema);
  if (schemaHash !== APPROVED_PLACE_EQUITY_ORDER_SCHEMA_HASH) {
    throw new Error("Robinhood place_equity_order schema changed; refusing live order");
  }

  return {
    account_number: order.account,
    symbol: order.symbol,
    side: order.side === "buy" ? "BUY" : "SELL",
    quantity: order.qty,
    order_type: order.type === "limit" ? "LIMIT" : "MARKET",
    time_in_force: "GFD",
    ...(order.limitPrice ? { limit_price: order.limitPrice } : {}),
  };
}
```

The exact field names/enums must come from the real Robinhood schema, not from this example.

---

### 2. CRITICAL — `robinhood_mcp_enabled=false` does not block live Robinhood order submission

| Field | Details |
|---|---|
| Files | `app/api/broker/orders/route.ts`, `lib/brokers/adapters/robinhood-mcp.ts`, `app/api/live-account/refresh-snapshot/route.ts` |
| Location | Order Gateway around lines 98-183; Robinhood adapter around lines 14-36 |
| Issue | The snapshot refresh path checks `robinhood_mcp_enabled`, but the live order path does not. |

Current behavior:

- `app/api/live-account/refresh-snapshot/route.ts` blocks MCP snapshot refresh when `robinhood_mcp_enabled` is false.
- `app/api/broker/orders/route.ts` does not check `robinhood_mcp_enabled` before calling `broker.submitOrder()`.
- `lib/brokers/adapters/robinhood-mcp.ts` also does not check the flag.

Concrete failure scenario:

1. User connects Robinhood OAuth once.
2. User turns `robinhood_mcp_enabled=false` in Settings, believing the integration is disabled.
3. `active_broker_us='robinhood_mcp'`.
4. A previously approved proposal is sent to broker.
5. Gateway checks global/per-market live trading flags, kill switches, quote drift, notional cap, and allowlist.
6. Because no code checks `robinhood_mcp_enabled`, the order can still reach Robinhood.

Fix:

In `app/api/broker/orders/route.ts`, after broker selection and before creating/submitting a broker order:

```ts
if (orderEnv === "live" && broker.id === "robinhood_mcp") {
  const { data: cfg, error } = await supabase
    .from("strategy_config")
    .select("robinhood_mcp_enabled")
    .limit(1)
    .maybeSingle();

  if (error || (cfg as any)?.robinhood_mcp_enabled !== true) {
    return NextResponse.json(
      { error: "Robinhood MCP is disabled in Settings" },
      { status: 403 }
    );
  }
}
```

Also duplicate the check inside `lib/brokers/adapters/robinhood-mcp.ts` as defense in depth:

```ts
const { data: cfg, error } = await svc
  .from("strategy_config")
  .select("robinhood_mcp_enabled")
  .limit(1)
  .maybeSingle();

if (error || (cfg as any)?.robinhood_mcp_enabled !== true) {
  return { ok: false, error: "Robinhood MCP is disabled" };
}
```

Acceptance test:

- Set `robinhood_mcp_enabled=false`.
- Set `active_broker_us='robinhood_mcp'`.
- Ensure an approved live proposal returns 403 before any MCP call.

---

### 3. CRITICAL — Ambiguous Robinhood place failures are downgraded to ordinary errors, allowing duplicate real orders

| Field | Details |
|---|---|
| Files | `lib/robinhood-mcp.ts`, `lib/brokers/adapters/robinhood-mcp.ts`, `app/api/broker/orders/route.ts`, `supabase/migrations/094_broker_orders_dup_submit_guard.sql` |
| Location | `submitRobinhoodOrder()` around lines 319-326; adapter around lines 30-35; Gateway around lines 183-186 |
| Issue | The Robinhood client detects possible-success timeout with `needsReconcile`, but the adapter discards that flag and the Gateway marks the order as `error`. This allows retry and duplicate order placement. |

Current logic:

```ts
// lib/robinhood-mcp.ts
return {
  ok: false,
  needsReconcile: true,
  error: `place ambiguous (possible success): ...`
};
```

Then:

```ts
// lib/brokers/adapters/robinhood-mcp.ts
if (!res.ok) return { ok: false, error: res.error };
```

Then:

```ts
// app/api/broker/orders/route.ts
if (!result.ok) {
  await supabase.from("broker_orders").update({ status: "error", error: result.error }).eq("id", orderId);
  return NextResponse.json({ error: result.error }, { status: 502 });
}
```

Concrete failure scenario:

1. App calls `place_equity_order`.
2. Robinhood receives and places the order.
3. Network times out before app receives response.
4. `submitRobinhoodOrder()` correctly returns `needsReconcile: true`.
5. Adapter drops `needsReconcile`.
6. Gateway marks broker order as `error`.
7. Migration 094 unique index only blocks active statuses:
   - `pending_submit`
   - `submitted`
   - `partially_filled`
8. Because status is `error`, the same proposal can be sent again.
9. Duplicate real order may be placed.

Fix:

Update broker result type:

```ts
export interface BrokerOrderResult {
  ok: boolean;
  brokerOrderId?: string;
  raw?: any;
  error?: string;
  needsReconcile?: boolean;
}
```

Preserve the flag in `lib/brokers/adapters/robinhood-mcp.ts`:

```ts
if (!res.ok) {
  return {
    ok: false,
    error: res.error,
    needsReconcile: res.needsReconcile,
    raw: res.raw,
  };
}
```

Handle it in Gateway:

```ts
if (!result.ok && result.needsReconcile) {
  await supabase.from("broker_orders").update({
    status: "unknown_needs_reconcile",
    error: result.error,
    raw_last_state: result.raw,
  }).eq("id", orderId);

  return NextResponse.json(
    { error: result.error, needs_reconcile: true },
    { status: 202 }
  );
}
```

Update the duplicate-submit index:

```sql
drop index if exists broker_orders_one_active_per_proposal;

create unique index broker_orders_one_active_per_proposal
  on broker_orders (proposal_id)
  where status in (
    'pending_submit',
    'submitted',
    'partially_filled',
    'unknown_needs_reconcile'
  );
```

Add a manual/admin reconciliation path using `get_equity_orders` before any retry is allowed.

---

### 4. HIGH — Trading settings route is authenticated but not owner-gated

| Field | Details |
|---|---|
| File | `app/api/settings/risk-profile/route.ts` |
| Location | `PATCH()` around lines 14-17; `GET()` around lines 164-168 |
| Issue | The route checks only for any authenticated user. It does not require the authenticated user to be the owner. |

Current logic:

```ts
const userClient = await createClient();
const { data: { user } } = await userClient.auth.getUser();
if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
```

This route can mutate:

- `trading_enabled_us`
- `trading_enabled_india`
- `active_broker_us`
- `active_broker_india`
- `active_account_us`
- `active_account_india`
- `live_account_source`
- `robinhood_mcp_enabled`
- `max_order_notional`

Concrete failure scenario:

1. A non-owner authenticated Supabase session exists due to OAuth/sign-up misconfiguration or a future auth regression.
2. Non-owner calls `PATCH /api/settings/risk-profile`.
3. They enable `robinhood_mcp_enabled`, lower `max_order_notional` safeguards, or switch active broker/account.
4. Owner later sends a trade, unaware the trading config was changed.

Fix:

Use `requireOwner()` in both `PATCH` and `GET`:

```ts
import { requireOwner } from "@/lib/auth/require-owner";

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  ...
}

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  ...
}
```

Acceptance test:

- Mock authenticated non-owner.
- `PATCH /api/settings/risk-profile` must return 403.
- `GET /api/settings/risk-profile` should also return 403 because it exposes trading config.

---

### 5. HIGH — SELL eligibility checks the wrong account snapshot

| Field | Details |
|---|---|
| Files | `app/api/broker/orders/route.ts`, `app/api/live-account/snapshot/route.ts`, `app/api/live-account/refresh-snapshot/route.ts` |
| Location | Sell gate around lines 156-159 in Gateway |
| Issue | The sell-only-if-held gate reads `live_account_snapshots.positions_json`, but the cached snapshot is hardcoded to account `965848641`, the manual/read-only Robinhood account. Live Robinhood orders are for agentic account `605420660`. |

Current Gateway sell check:

```ts
const { data: snap } = await supabase
  .from("live_account_snapshots")
  .select("positions_json")
  .order("captured_at", { ascending: false })
  .limit(1)
  .maybeSingle();

const positions: any[] = (snap as any)?.positions_json ?? [];
const held = Array.isArray(positions) && positions.some(...);
```

But snapshot GET filters:

```ts
.eq("account_id", "965848641")
```

And MCP refresh writes:

```ts
account_id: "965848641"
```

Concrete failure scenario:

- Manual/read-only account `965848641` holds AAPL.
- Agentic trading account `605420660` does not hold AAPL.
- A SELL AAPL proposal reaches the Gateway.
- Gateway checks the latest snapshot from `965848641`, sees AAPL, and allows the sell.
- Robinhood receives a sell request for the agentic account.

Depending on Robinhood behavior, this may be rejected, or worse, could create an unintended short/sell behavior if ever supported.

Fix:

- Store snapshots per account.
- For Robinhood live orders, validate SELL against the active trading account:
  - `strategy_config.active_account_us`, expected `605420660`
  - `broker_accounts.role='trading'`
- The sell check should query:

```ts
.eq("account_id", activeTradingAccount)
```

Better: fetch live positions from Robinhood MCP immediately before sell submission:

```ts
const positions = await queryRobinhoodPositions(activeTradingAccount);
```

Then verify:

- symbol exists
- quantity is finite
- quantity >= proposed sell quantity

Also fix `refreshViaMcp()` so it does not write Robinhood MCP snapshots to `965848641` when the active MCP trading account is `605420660`.

---

### 6. HIGH — Broker selection silently falls back on config read errors in the live order path

| Field | Details |
|---|---|
| File | `lib/brokers/registry.ts` |
| Location | `getActiveBroker()`, around lines 34-54 |
| Issue | If `strategy_config.active_broker_us` read fails for any reason, the function logs and falls back to Alpaca for US or Kite for India. This is unsafe in an order execution path. |

Current behavior:

```ts
if (error) {
  ...
  return getBroker(fallback)!;
}
...
return getBroker(id) ?? getBroker(fallback)!;
```

Concrete failure scenario:

1. User selects `robinhood_mcp` as active US broker.
2. Supabase read of `active_broker_us` fails transiently.
3. `getActiveBroker()` falls back to `alpaca`.
4. If Alpaca live keys are configured and request env is `live`, the order can route to Alpaca live instead of Robinhood.

Fix:

Create a strict broker resolver for the order path:

```ts
export async function getActiveBrokerForOrder(
  supabase: any,
  market: "us" | "india"
): Promise<{ ok: true; broker: BrokerAdapter } | { ok: false; error: string }> {
  const col = market === "india" ? "active_broker_india" : "active_broker_us";
  const { data, error } = await supabase.from("strategy_config").select(col).maybeSingle();

  if (error) {
    return { ok: false, error: `Could not read ${col}: ${error.message}` };
  }

  const id = (data as any)?.[col];
  if (!id) return { ok: false, error: `No active broker configured for ${market}` };

  const broker = getBroker(id);
  if (!broker) return { ok: false, error: `Unknown active broker '${id}'` };

  return { ok: true, broker };
}
```

Use this strict resolver in `app/api/broker/orders/route.ts`.

Keep the fallback resolver only for non-order UI display paths.

---

### 7. HIGH — Token refresh is not actually single-writer/CAS

| Field | Details |
|---|---|
| File | `lib/robinhood-mcp.ts` |
| Location | `refreshAccessToken()`, `storeTokens()`, around lines 121-176 |
| Issue | Comments claim compare-and-swap/single-writer refresh, but the code performs plain read, refresh, and upsert. No advisory lock, no `updated_at` comparison, no transaction. |

Current misleading comment:

```ts
// Single-writer refresh: re-read the expiry after acquiring, and only refresh if
// still stale (compare-and-swap on the vault's updated_at guards against two
// concurrent refreshers racing and one persisting a dead rotated token).
```

Actual behavior:

- Reads client ID.
- Reads refresh token.
- Calls token endpoint.
- Upserts access token.
- Upserts refresh token.
- Upserts expiry.

No CAS is performed.

Concrete failure scenario:

1. Cron snapshot refresh and user order submit happen at the same time.
2. Both see access token near expiry.
3. Both read the same refresh token.
4. Both call Robinhood token refresh.
5. If Robinhood rotates refresh tokens, one refresh token may invalidate the other.
6. Last writer may persist a stale/dead refresh token.
7. Robinhood connection breaks or, worse, behavior becomes nondeterministic during order submission.

Fix:

Implement a real single-writer refresh with one of:

Option A — Postgres advisory lock:

```sql
select pg_advisory_xact_lock(hashtext('robinhood_mcp_refresh'));
```

Then refresh and store tokens inside a single RPC/transaction.

Option B — CAS:

- Add `updated_at` or `version` to the vault row if not already reliable.
- Read refresh token + version.
- Refresh.
- Update only if version unchanged:

```sql
update api_key_vault
set key_value = new_refresh, updated_at = now()
where key_name = 'ROBINHOOD_MCP_REFRESH_TOKEN'
  and updated_at = old_updated_at;
```

If zero rows updated, another process won; re-read tokens instead of overwriting.

Also make `vaultSet()` return/throw on Supabase errors. It currently ignores failed writes.

---

### 8. HIGH — Successful place with missing order ID is treated as success

| Field | Details |
|---|---|
| Files | `lib/robinhood-mcp.ts`, `app/api/broker/orders/route.ts` |
| Location | `extractOrderId()` around lines 330-335; Gateway success update around lines 188-194 |
| Issue | `extractOrderId()` can return `undefined`, but the Gateway still marks the order as submitted and returns success. |

Current logic:

```ts
const brokerOrderId = extractOrderId(content);
return { ok: true, brokerOrderId, raw: redact(content) };
```

Then:

```ts
await supabase.from("broker_orders").update({
  status: "submitted",
  broker_order_id: result.brokerOrderId,
  submitted_at: new Date().toISOString(),
  raw_last_state: result.raw,
}).eq("id", orderId);
```

Concrete failure scenario:

- Robinhood places the order.
- MCP response returns order ID under a key like `orderId`, `order_uuid`, nested content, or plain text.
- `extractOrderId()` returns `undefined`.
- App marks order as `submitted` without a broker order ID.
- Sync/reconciliation cannot track it.
- User may retry or lose visibility.

Fix:

For live orders:

- If place succeeds but no order ID is extracted, mark `unknown_needs_reconcile`.
- Do not return normal success.
- Reconcile using `get_equity_orders`.

Example:

```ts
if (!brokerOrderId) {
  return {
    ok: false,
    needsReconcile: true,
    raw: redact(content),
    error: "Robinhood order response did not include a parseable order id; reconcile before retry",
  };
}
```

Also improve `extractOrderId()` to handle structured MCP content arrays and known Robinhood response fields once observed.

---

### 9. MED — Account allowlist validation does not filter by broker

| Field | Details |
|---|---|
| Files | `app/api/broker/orders/route.ts`, `lib/brokers/adapters/robinhood-mcp.ts`, `app/api/settings/risk-profile/route.ts` |
| Location | Gateway account resolver around lines 23-39; Robinhood adapter resolver around lines 50-61; Settings validation around lines 132-142 |
| Issue | Account validation checks `account_number` and `market`, but not `broker`. |

Current Gateway logic:

```ts
.from("broker_accounts")
.select("role")
.eq("account_number", account)
.eq("market", market)
.maybeSingle();
```

Concrete failure scenario:

- A row exists in `broker_accounts` for another broker with the same account number and `role='trading'`.
- Robinhood account validation sees it and accepts the active account.
- The wrong broker/account relationship is treated as valid.

Fix:

Include broker in every allowlist lookup:

Gateway:

```ts
.eq("broker", broker.id)
.eq("account_number", account)
.eq("market", market)
```

Robinhood adapter:

```ts
.eq("broker", "robinhood")
.eq("account_number", account)
.eq("market", "us")
```

Settings validation should validate active account against both market and intended broker, or active account should be stored as `(broker, account_number)` rather than only account number.

---

### 10. MED — OAuth state signing has an insecure fallback and reuses unrelated high-value secrets

| Field | Details |
|---|---|
| File | `lib/robinhood-mcp.ts` |
| Location | `stateSecret()`, lines 59-60 |
| Issue | If no OAuth state secret is configured, the code falls back to `CRON_SECRET`, then `SUPABASE_SERVICE_ROLE_KEY`, then a hardcoded string. |

Current logic:

```ts
function stateSecret(): string {
  return process.env.OAUTH_STATE_SECRET
    ?? process.env.CRON_SECRET
    ?? process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? "insecure-dev-fallback";
}
```

Problems:

- Production can accidentally run with `"insecure-dev-fallback"`.
- Reusing `SUPABASE_SERVICE_ROLE_KEY` couples OAuth cookie integrity to a broader DB super-secret.
- Reusing `CRON_SECRET` broadens blast radius.

Fix:

Require `OAUTH_STATE_SECRET` for any non-development environment:

```ts
function stateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("OAUTH_STATE_SECRET must be set to at least 32 random bytes");
  }
  return secret;
}
```

If local dev fallback is necessary, gate it explicitly:

```ts
if (process.env.NODE_ENV === "development") return "local-dev-only...";
```

Do not fall back to service role or cron secret.

---

### 11. MED — MCP response parsing can misread malformed/partial responses as success

| Field | Details |
|---|---|
| File | `lib/robinhood-mcp.ts` |
| Location | `parseMcpBody()` and `mcpRpc()`, around lines 196-235 |
| Issue | The client takes the last SSE `data:` JSON object and treats HTTP 200 with no `parsed.error` as success, even if no JSON-RPC result exists or the MCP tool returned an error inside `content`. |

Current logic:

```ts
if (parsed?.error) return { ok: false, ... };
return { ok: true, result: parsed?.result, sessionId: sid ?? undefined };
```

Missing checks:

- JSON-RPC response `id` matches request `id`.
- `result` exists for non-notification calls.
- MCP `tools/call` result has `isError !== true`.
- Empty/malformed SSE stream is rejected.

Concrete failure scenario:

- Robinhood returns HTTP 200 with an MCP tool error encoded as content or `isError: true`.
- `mcpRpc()` does not inspect it.
- Caller treats it as successful review/place.

Fix:

- Store request ID and require response ID match.
- Reject non-notification responses with no `result`.
- For `tools/call`, treat `result.isError === true` as failure.
- For write calls, require a structured success confirmation and order ID.

Example:

```ts
if (!parsed || parsed.id !== id) {
  return { ok: false, error: "Invalid MCP response id" };
}
if (parsed.error) ...
if (!("result" in parsed)) {
  return { ok: false, error: "MCP response missing result" };
}
if (method === "tools/call" && parsed.result?.isError === true) {
  return { ok: false, error: serializeToolError(parsed.result) };
}
```

---

### 12. MED — Request guard has a weak cron-secret bypass pattern

| Field | Details |
|---|---|
| File | `lib/request-guards.ts` |
| Location | `guardOrderRequest()`, lines 39-43 |
| Issue | The order request guard bypasses Host/Origin checks if `x-cron-secret === process.env.CRON_SECRET`, using plain equality and no fail-closed empty-secret handling. |

Current logic:

```ts
const cronSecret = req.headers.get("x-cron-secret");
if (cronSecret === process.env.CRON_SECRET) return null;
```

Why this matters:

- The current broker order route calls `requireOwner()` before this guard, which limits immediate exploitability.
- But this helper is explicitly for order-placing routes.
- Order routes should not have any cron bypass concept at all.
- If reused in another order endpoint without owner gating, this becomes dangerous, especially when `CRON_SECRET` is unset/empty.

Fix:

Remove the cron bypass from `guardOrderRequest()` entirely:

```ts
export function guardOrderRequest(req: NextRequest): NextResponse | null {
  ...
  // no cron bypass here
}
```

If a non-order route needs cron auth, use `verifyCronSecret()` in that route only.

---

## Specific Questions Answered

### 1. Can `buildArgsFromSchema` emit a valid but semantically wrong real order?

Yes. This is the scariest current defect. The `amount` alias alone is enough to block go-live. The mapper can fill required fields while getting units/enums wrong.

### 2. Any way to place a live order while `robinhood_mcp_enabled=false`, or bypass account/kill/notional/drift?

Yes for `robinhood_mcp_enabled=false`: the order path does not enforce it.

The account allowlist is mostly enforced, but it should include `broker` in the lookup.

The global/per-market trading flags, kill switches, notional cap, and drift checks are present in the Gateway. However, broker selection can silently fall back to another broker on config read errors, which is unsafe for live orders.

### 3. OAuth token theft or session fixation via state cookie or redirect URI?

The state/PKCE flow is directionally correct: owner-gated login/callback, signed HttpOnly cookie, SameSite=Lax, short TTL, hardcoded post-auth redirect.

The main issues are:

- insecure/fuzzy state secret fallback;
- token refresh is not actually CAS/single-writer;
- `vaultSet()` ignores write errors.

### 4. Does notional cap fallback leave orders uncapped when equity is unknown?

No. This part is implemented correctly.

`app/api/broker/orders/route.ts` refuses live orders when both `max_order_notional` and live equity are unavailable:

```ts
if (notionalCap == null || !Number.isFinite(notionalCap) || notionalCap <= 0) {
  return NextResponse.json({
    error: "Cannot determine a notional cap ..."
  }, { status: 403 });
}
```

### 5. Anything that should block go-live?

Yes. Block go-live until at least findings 1-8 are fixed and tested.

---

## Go-Live Gate Checklist

Before enabling real Robinhood orders:

- [ ] Replace `buildArgsFromSchema()` for order placement with a pinned Robinhood-specific schema adapter.
- [ ] Verify `review_equity_order` output exactly matches the proposal before placing.
- [ ] Enforce `robinhood_mcp_enabled` in Gateway and adapter.
- [ ] Preserve `needsReconcile` through adapter and Gateway.
- [ ] Add `unknown_needs_reconcile` to active duplicate-submit statuses.
- [ ] Implement `get_equity_orders` reconciliation before retry.
- [ ] Owner-gate `app/api/settings/risk-profile/route.ts`.
- [ ] Validate SELLs against active trading account `605420660`, not read-only account `965848641`.
- [ ] Use strict broker resolver in live order path; no fallback.
- [ ] Implement real CAS/advisory-lock token refresh.
- [ ] Require `OAUTH_STATE_SECRET`; remove production fallback.
- [ ] Harden MCP response parser and require order ID/confirmation.
- [ ] Remove cron-secret bypass from order request guard.

---

## Lower-Stakes Agent-System Notes

### Kelly sizing

The shared `lib/risk/sizing.ts` implementation is directionally correct:

- uses payoff-ratio Kelly;
- caps at half Kelly;
- returns `0` on no edge;
- uses fraction units internally.

Paper trading now converts percent config to fractions and back. That is correct.

One behavioral note: `app/api/agents/trader/route.ts` keeps flat sizing when Kelly returns no edge. That is acceptable for proposal generation because a human still approves, but it should be clearly labeled in the UI as “flat fallback despite no calibrated Kelly edge.” Do not use that fallback for autonomous live orders.

### Alpha Vantage budget

`lib/av-cache.ts` reserves before spend, which is safe for API quota. However, if the `av_budget_increment` RPC fails, it fails open and spends a real call:

```ts
} catch { /* counter unavailable → fall through and spend */ }
```

For free-tier budget preservation, fail closed would be safer. For data freshness, fail open is understandable. This is not a live-trading blocker, but for predictable free-tier operation, consider returning last cached payload on counter failure.

### Trailing stop

The new `initial_stop_loss` trigger/backfill is a reasonable fix. The clamp `0.5–0.99` prevents broken anchors from causing absurd stops. Not a blocker.

### `verifyCronSecret`

`lib/auth/cron.ts` is implemented correctly for normal cron routes:

- fails closed when `CRON_SECRET` is unset;
- checks length before `timingSafeEqual`;
- avoids accepting empty secrets.

Do not duplicate weaker cron-secret comparisons elsewhere.
