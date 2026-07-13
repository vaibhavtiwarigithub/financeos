# Feature Architecture — Webull as 3rd Broker (MCP)

> Status: **Phase 1 (read-only, Cloud MCP) BUILT — awaiting owner OAuth connect.**
> Decision: **Cloud MCP (OAuth), not OpenAPI** — the OpenAPI REQUIRES an IP
> whitelist (no free serverless has a static egress IP; would force an Oracle
> Free VM), whereas the MCP's OAuth is not IP-locked and runs from Vercel free.
> Reuses the Robinhood MCP OAuth machinery.
> Last updated: 2026-07-13

## Phase 1 built (read-only)
- `lib/webull-mcp.ts` — OAuth 2.1 (DCR + PKCE S256, hosted Vercel callback) +
  CAS token refresh (vault keys `WEBULL_MCP_*`, provider `webull_mcp`) +
  `webullRpc` JSON-RPC client + `captureWebullAccounts()` (get_account_list →
  get_account_positions + get_account_balance → get_stock_quotes). Scope
  `account:read market:read instrument:read` ONLY — no `order:write`, no order code.
- Routes `app/api/webull/{login,callback,status,disconnect}`.
- Settings "Connect Webull" card. `BrokerName` union +`webull`.
- **Owner action:** click Connect Webull once (cloud OAuth) → token in vault →
  crons reuse it. Then verify holdings appear.
- **Phase 2 (later):** order adapter (`order:write` + preview→place→status→cancel)
  behind an explicit per-account allowlist + all existing gates. NOT built.

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

**Tool schema (verbatim), mapped to our adapter contract:**
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

This is a 1:1 match to `captureAllRobinhoodAccounts` (list→positions→balance→quote)
and the RH order path (review→place→status→cancel). US equities.

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
- `lib/brokers/webull-mcp.ts` implementing `BrokerAdapter` (review → place →
  snapshot; `needsReconcile` on ambiguous submit / missing order id). Register in
  `registry.ts`.
- An account becomes order-capable ONLY when you explicitly allowlist it
  (`agentic_allowed=true` on that one account, exactly like RH `605420660`).
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
