# Feature Architecture — Webull as 3rd Broker (MCP)

> Status: **Phase 1 (read-only, Cloud MCP) BUILT — OAuth connected; live read capture still fail-soft if a configured tool is not offered by the connected MCP surface.**
> Decision: **Cloud MCP (OAuth), not OpenAPI** — the OpenAPI REQUIRES an IP
> whitelist (no free serverless has a static egress IP; would force an Oracle
> Free VM), whereas the MCP's OAuth is not IP-locked and runs from Vercel free.
> Reuses the Robinhood MCP OAuth machinery.
> Last updated: 2026-07-13
> **Refactored 2026-07-13 onto the config-driven MCP broker framework** — Webull
> is now a registry entry, not bespoke code (see "Config-driven framework" below).
> **Reviewer correction 2026-07-13:** the currently connected Codex Webull MCP
> surface exposes account/balance/position/order-history style read tools, but not
> the quote/research/order-placement tools listed in the original architecture.
> Treat quote/research/order tool names as unverified until `tools/list` in the
> deployed app proves them. The order adapter must remain unreachable.

## Config-driven framework (2026-07-13 refactor)
The bespoke `lib/webull-mcp.ts` was generalized so future OAuth-MCP read-only
brokers (E*TRADE, other US/India) are added by a CONFIG ENTRY, not new code:
- `lib/brokers/mcp-registry.ts` — `McpBrokerConfig` type + `MCP_BROKERS` registry
  (id/label/market/currency, mcpUrl, oauth endpoints+scopes, vaultProvider+keys,
  tool names, and response field-name candidates). Seeded with the **webull** entry
  (same endpoints/scopes/tools/vault keys — behaviour-neutral).
- `lib/brokers/mcp-driver.ts` — the generic driver: every fn takes an
  `McpBrokerConfig` — `getOrRegisterClient` / `buildAuthUrl` / `exchangeCode` /
  `getValidAccessToken` (CAS refresh) / `hasToken` / `mcpRpc` / `captureAccounts`
  (driven by cfg.tools + cfg.fields → `BrokerAccount[]`) / `checkTokenHealth` /
  `disconnect` / `saveOAuthState`+`consumeOAuthState` (keyed by broker id).
  Reuses `makePkce/makeState/signOAuthCookie/verifyOAuthCookie/mcpToolJson` from
  `lib/robinhood-mcp.ts`.
- Generic routes `app/api/broker-mcp/[broker]/{login,callback,status,disconnect}`
  resolve the config from `MCP_BROKERS[broker]` (404 if unknown). Login/status/
  disconnect owner-gated; callback verifies the single-use server-side state.
- Settings iterates `MCP_BROKERS` → one connect card per broker (future brokers
  auto-render). The legacy `app/api/webull/*` routes are thin 307 redirects to the
  generic ones (preserving the DCR-registered `/api/webull/callback` redirect_uri).
- `lib/webull-mcp.ts` was **deleted** — nothing imported it after the repoint.

## Phase 1 built (read-only)
- OAuth 2.1 (DCR + PKCE S256, hosted Vercel callback) + CAS token refresh (vault
  keys `WEBULL_MCP_*`, provider `webull_mcp`) + JSON-RPC client + `captureAccounts()`
  (get_account_list → get_account_positions + get_account_balance → get_stock_quotes),
  now via the generic `lib/brokers/mcp-driver.ts` + `MCP_BROKERS.webull`. Scope
  `account:read market:read instrument:read` ONLY. If the connected MCP surface
  omits `get_stock_quotes`, capture fails soft rather than fabricating prices.
  No `order:write` scope is requested by the login route.
- Legacy routes `app/api/webull/{login,callback,status,disconnect}` → 307 redirects
  to `app/api/broker-mcp/webull/{login,callback,status,disconnect}`.
- Settings connect card (generic, driven by the registry). `BrokerName` union +`webull`.
- **Owner action:** already connected once through cloud OAuth. Verify holdings
  appear after the next live snapshot, and investigate only read-tool gaps.
- **Phase 2 (later):** order adapter (`order:write` + preview→place→status→cancel)
  behind an explicit per-account allowlist + all existing gates. Code exists only
  as an inert adapter scaffold and is not reachable while `orderCapable=false`,
  `webull_orders_enabled` is absent/false, and no Webull trading allowlist row is
  configured.

## Confirmed integration facts (from public OAuth metadata + Webull MCP docs)

**Cloud MCP endpoint:** `https://api.webull.com/mcp` (JSON-RPC, MCP spec).
**Auth = OAuth 2.1 + PKCE(S256) + dynamic client registration** — identical shape
to the Robinhood MCP already implemented in `lib/robinhood-mcp.ts`, so those
helpers are reused with Webull's endpoints:
- authorize: `https://passport.webull.com/oauth2/ai-mcp/login`
- token: `https://u1suserauth.webullfintech.com/api/userauth/oauth/token/token`
- register: `https://u1suserauth.webullfintech.com/api/userauth/oauth/client/register`
- public client (`token_endpoint_auth_method: none`), grants `authorization_code`+`refresh_token`
- scopes: `account:read order:read order:write market:read instrument:read`

**Tool schema status: partly verified, order placement unverified.**

Current connected tool exposure in Codex on 2026-07-13 included:
`get_account_list`, `get_account_balance`, `get_account_positions`,
`get_order_detail`, `get_instruments`, `get_open_orders`, `get_order_history`.
It did **not** expose `get_stock_quotes`, `get_stock_snapshot`,
`preview_stock_order`, `place_stock_order`, `cancel_order`, or the analyst/
financial research tools. The table below is therefore a desired/previous-doc
mapping, not proof that orders can be placed from this app today.

| Need | Webull MCP tool |
|---|---|
| accounts | `get_account_list` |
| balance / buying power | `get_account_balance` |
| holdings | `get_account_positions` |
| quotes (pricing) | `get_stock_quotes` / `get_stock_snapshot` |
| review order | `preview_stock_order` |
| place order | `place_stock_order` |
| order status | `get_order_detail` |
| open orders | `get_open_orders` |
| cancel | `cancel_order` |

Only the account/balance/position/order-read portion is currently verified in
this Codex connection. Quotes and order placement must stay fail-soft/unreachable
until a deployed `tools/list` proves the tools and schemas.

## Goal
Add Webull as a third broker — US equities, parallel to Robinhood — using the
existing broker abstraction (`BrokerAdapter` + registry). Same safety stack; the
adapter only executes, every gate sits above it.

## Why it fits cleanly
`lib/brokers/adapter-types.ts`: "adding an execution broker = one new file
implementing this interface + one registry entry. Zero route/UI changes." Webull
is US (like Robinhood), and it's an MCP — so the **Robinhood-MCP integration is
the template**, reused almost verbatim with a different endpoint + tool names.

## Build (phased — read-only first)

### Phase 0 — Discovery (interactive; blocks the rest)
The exact OAuth endpoints + tool names come from the live server, not guesswork.
Standard MCP auth = OAuth 2.1 + dynamic client registration via a
`.well-known/oauth-authorization-server` discovery doc — the **same flow the RH
integration already implements** (`lib/robinhood-mcp.ts`: DCR → PKCE S256 →
token in vault → CAS refresh). Steps:
1. Connect the Webull MCP (interactive OAuth) — owner authorizes.
2. Call `tools/list` to capture the real tool names (accounts / positions /
   quotes / review-order / place-order / order-status / cancel).
3. Pin those into the client. No adapter code is written against guessed names.

### Phase 1 — Read-only (dashboard)
- `lib/webull-mcp.ts` — generic `webullRpc(token, method, params, session)` (copy
  of RH's `mcpRpc`, endpoint `https://api.webull.com/mcp`) + `captureWebullAccounts()`
  → `BrokerAccount[]`.
- `broker_accounts` row(s): `broker='webull'`, `market='us'`, `account_role`,
  `enabled`, `notional_cap_usd`, `agentic_allowed=false` (reads only).
- Wire into the live account book (like the 6 RH accounts): holdings, risk, the
  live-vs-VOO chart, `live_account_snapshots`.
- OAuth routes `/api/webull/login` + `/api/webull/callback` — reuse the RH
  OAuth helpers (dynamic client reg, PKCE, signed state cookie, vault token, CAS
  refresh). Owner-gated login; callback verifies the state nonce.
- Settings: Webull connect card + account list (mirror the RH-MCP card).

### Phase 2 — Order-capable (only if opted in)
- `lib/brokers/adapters/webull.ts` is an inert adapter scaffold. It must not be
  enabled until live tool discovery proves preview/place/status/cancel schemas,
  Webull order scopes are intentionally requested, and the owner approves.
- An account becomes order-capable ONLY when you explicitly allowlist it
  (`broker_accounts{broker='webull', market='us', role='trading'}`) and the broker
  registry marks Webull order-capable.
- Every existing gate applies unchanged: `isTradingEnabled(svc,'us')`,
  per-market controls, kill switch, notional caps, human click + confirm.

## Safety (unchanged)
- Read-only first; orders are a separate, opt-in phase.
- One allowlisted account for orders; all others read-only.
- Credentials never in code/logs — vault only; owner enters/authorizes.
- Same fail-closed order path as RH (dup-index, durable ACK, reconcile).

## Two decisions needed to start
1. **Scope:** read-only (holdings on the dashboard) first — recommended — or go
   straight to order-capable?
2. **Discovery:** how do I get its tool schema — (a) you add the Webull MCP as a
   connector to this app so I can `tools/list` it, or (b) you paste the Webull
   MCP auth + tool docs? (I can't run the interactive OAuth from here.)
