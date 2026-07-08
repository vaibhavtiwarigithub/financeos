# Review request — Robinhood MCP integration (real-money live trading) + agent-system audit fixes

You are doing an adversarial security + correctness review of a **real-money
live-trading** feature just built into a personal Next.js 15 + Supabase algo-
trading app (Kairos/FinanceOS). Assume a hostile environment. Your job is to
find defects that could (a) place a wrong/unauthorized real order, (b) leak or
mishandle OAuth tokens, (c) let a non-owner reach owner-only data/actions, or
(d) silently corrupt the agent pipeline. Be specific: cite the file + the exact
logic, give a concrete failure scenario, and state the fix. Rank by severity.
Do NOT rubber-stamp — if something is fine, skip it.

## How to give me the code
Run this in the repo and paste the output for the reviewer:
```
git -C "C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS" show --stat HEAD~3..HEAD
git -C "C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS" diff HEAD~4..HEAD -- lib/robinhood-mcp.ts app/api/robinhood-mcp app/api/broker/orders/route.ts lib/brokers app/api/settings/risk-profile/route.ts app/api/live-account lib/request-guards.ts lib/auth
```

## What was built (context)

**Robinhood MCP live-trading integration.** Robinhood exposes a remote MCP
server at `https://agent.robinhood.com/mcp/trading`. OAuth 2.1 metadata was
verified live:
- authorization_endpoint `https://robinhood.com/oauth`
- token_endpoint `https://api.robinhood.com/oauth2/token/`
- registration_endpoint `https://agent.robinhood.com/oauth/trading/register`
- scope `internal`, PKCE S256, `token_endpoint_auth_method=none` (public client)
- resource `https://agent.robinhood.com/mcp/trading`

Design intent (LOCKED): **no LLM anywhere in the order write path.** LLMs only
produce research/proposals; typed server code executes an approved proposal.

Key files & logic to scrutinize:

1. **`lib/robinhood-mcp.ts`** — OAuth (dynamic client registration, PKCE,
   token exchange + refresh), token storage in a Supabase `api_key_vault`
   table, and a hand-rolled MCP JSON-RPC client (`initialize` → `tools/list` →
   `review_equity_order` → `place_equity_order`).
   - PKCE verifier + state are round-tripped through an **HMAC-signed HttpOnly
     cookie** (`signOAuthCookie`/`verifyOAuthCookie`), secret =
     `OAUTH_STATE_SECRET ?? CRON_SECRET ?? SUPABASE_SERVICE_ROLE_KEY`. Is this
     construction sound? Cookie forgery? Missing-secret fallback risk?
   - Token refresh: `getValidAccessToken` refreshes within 60s of expiry. Is
     there a race / double-refresh token-rotation hazard? (No advisory lock is
     used — is the CAS actually a CAS?)
   - **`buildArgsFromSchema`**: since I don't have Robinhood's exact
     `place_equity_order` arg schema, the code fetches the tool's `inputSchema`
     at runtime and maps canonical fields (symbol/side/qty/type/limitPrice/
     account/tif) onto the schema's property names via an alias table, and
     ABORTS if a required property can't be filled. **Scrutinize this hard**:
     could a wrong alias map (e.g. `amount` meaning dollars not shares, or
     `side`/`transaction_type` expecting "B"/"S" vs "buy"/"sell") produce a
     valid-but-wrong real order? Is failing-closed actually guaranteed?
   - SSE vs JSON response parsing (`parseMcpBody`) — correct? Could it mis-read
     an error as success, or miss the order id?
   - `extractOrderId` regex, `redact` of raw payloads before persistence.

2. **`app/api/robinhood-mcp/login/route.ts` + `callback/route.ts`** — owner-
   gated OAuth endpoints. Check: state/PKCE verification, redirect_uri
   consistency between login and callback, that the callback can't be driven by
   an attacker (CSRF), cookie flags, that `code`/`state` handling can't be
   bypassed, hardcoded post-auth redirect (no open redirect).

3. **`app/api/broker/orders/route.ts`** (Execution Gateway) — the submit-time
   gate for ALL brokers (Alpaca/Kite/Robinhood). Newly added: owner+CSRF guard,
   explicit `env` required, both-direction `broker.envs` check, kill switches,
   fresh-quote **notional cap** (config value or 15% of live equity), **price-
   drift** re-check vs `price_at_proposal`, **sell-only-if-held** (checks the
   latest `live_account_snapshots.positions_json`), symbol/qty validation, and
   **fail-closed account-allowlist resolution** against a `broker_accounts`
   table (role must be `trading`). Attack the ordering and the bypasses: can any
   path reach `broker.submitOrder` skipping a check? Is the sell-if-held parse
   robust to snapshot shape? Can a stale/empty snapshot wrongly block or allow?
   Is the notional fallback safe when equity is unknown (null cap → no cap!)?

4. **`lib/brokers/adapters/robinhood-mcp.ts`** — adapter; re-validates the
   account allowlist as the last line before the wire. `isConfigured()` =
   token-present. `envs=['live']`.

5. **`app/api/settings/risk-profile/route.ts`** — now also writes
   `active_account_us/india` (validated against the allowlist), `live_account_
   source`, `robinhood_mcp_enabled` (default OFF), `max_order_notional`. Check
   the allowlist validation can't be bypassed with a crafted body.

6. **DB (Supabase) — migrations 089–094:**
   - 089: `api_key_vault` + `broker_orders` locked to service-role-only (they
     had a `USING(true)` policy / RLS-disabled — anyone with the public anon
     key could write). Confirm the reasoning; any table still exposed?
   - 093: `broker_accounts` allowlist (service-role-only), account/source/enable
     columns, notional cap.
   - 094: partial unique index `broker_orders(proposal_id) WHERE status in
     (pending_submit,submitted,partially_filled)` as the dup-submit backstop.

7. **Agent-system audit fixes (same batch, lower stakes but check):**
   - Kelly sizing: both `paper-trade` and `trader` routes were mis-scaled
     (one always-floor, one always-ceiling); now both use
     `lib/risk/sizing.ts` (payoff-ratio Kelly, caps as fractions, result → %).
     Verify the unit conversions and the no-edge→skip semantics.
   - Alpha Vantage day-cache + `av_budget` counter (`lib/av-cache.ts`,
     migration 090): reserve-before-spend increment; does the budget guard
     fail open or closed on counter error, and is that the right choice?
   - Trailing stop (`position-monitor`, migration 091): trails at the
     position's own `initial_stop_loss/avg_cost` distance (clamped 0.5–0.99)
     instead of a hardcoded 7%. Check the clamp + backfill correctness.
   - `verifyCronSecret` (`lib/auth/cron.ts`): timingSafeEqual, fails closed on
     unset secret. Correct against length-leak / empty-secret?

## Specific questions I most want answered
1. Can `buildArgsFromSchema` ever emit a **valid but semantically wrong** real
   order (units, enum values, market vs limit, missing tif)? This is the
   scariest path.
2. Any way to place a live order while `robinhood_mcp_enabled=false`, or on an
   account not marked `trading`, or bypassing kill switches / notional / drift?
3. OAuth token theft or session-fixation via the state cookie or redirect_uri.
4. Does the notional-cap fallback (`null cap` when equity unknown) leave orders
   **uncapped**? If so, that's a finding.
5. Anything that should block go-live for real money that I've missed.

Output a numbered, severity-ranked findings list (CRITICAL/HIGH/MED/LOW), each
with file, the exact defect, a concrete exploit/failure scenario, and the fix.
