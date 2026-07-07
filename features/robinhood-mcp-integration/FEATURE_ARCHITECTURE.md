# Feature Architecture: In-App Robinhood MCP Client — read-only snapshot + human-gated live order execution + allowlist-backed account selector

## Status

Architecture status: Draft (security-hardened rewrite, 2026-07-07)
Architecture approved: No
Approved scope: None
Approved date: None
Implementation allowed: No

## Revision history

- 2026-07-06 — original draft: read-only snapshot via DeepSeek+MCP, no order execution.
- 2026-07-07 (a) — scope expanded at user request: live order execution via the existing broker-adapter/Gateway pattern; `live_account_source` switch; `broker_accounts` allowlist + per-market active-account selector.
- 2026-07-07 (b) — **this rewrite**: full security review (18 findings) folded in as binding rules. Biggest changes: **no LLM anywhere in the order write path** (direct typed `client.callTool()` instead of a "DeepSeek tool-calling loop"), OAuth hardening (state+PKCE+authenticated callback — the Kite route-pair is NOT a safe template for OAuth 2.1), the Execution Gateway is explicitly MODIFIED (not "unchanged") to add kill-switch/guard/env/notional checks it does not have today, `robinhood_mcp_enabled` defaults OFF, fail-closed account resolution, and reconcile-before-resubmit semantics for ambiguous order timeouts. Prerequisite vault lockdown (migration 089) was applied live 2026-07-07: `api_key_vault` had a `USING (true)` policy for all roles with client write grants, and `broker_orders` had RLS disabled — both now service-role-only.

## Feature Purpose

Today, refreshing the live Robinhood account snapshot (equity, buying power,
positions for the read-only Trading account `965848641`) depends on
`execClaude` (`lib/claude-exec.ts`) — Windows-desktop-only, fails on Vercel.
Robinhood order execution (account `605420660`) is fully manual: approving a
proposal generates a natural-language command the user pastes into their own
Claude Code session with Robinhood MCP access.

This feature adds an in-app path for both concerns, using Robinhood's real
remote MCP server (`https://agent.robinhood.com/mcp/trading`, confirmed via
the user's `.claude.json`; it exposes `get_accounts`, `get_equity_positions`,
`place_equity_order`, `review_equity_order`, `cancel_equity_order`,
`get_equity_orders`, among others):

1. **Read path** — a deterministic MCP client fetches the account snapshot
   server-side (Vercel or local), replacing/coexisting with `execClaude`,
   selected by a new `strategy_config.live_account_source` switch
   (`'claude_exec' | 'robinhood_mcp'`, default `'claude_exec'`).
2. **Write path** — Robinhood becomes a third broker adapter in
   `lib/brokers/registry.ts` (alongside Alpaca and Kite), flowing through the
   Execution Gateway with the same two-human-click gate (Approve →
   Send to broker). The only change vs today is transport: a typed MCP call
   instead of a manual paste. **Who decides never changes.**
3. **Account selector** — a `broker_accounts` allowlist table +
   `active_account_us`/`active_account_india` so future additional accounts
   are user-selectable but never implicitly tradable.

## BINDING IMPLEMENTATION RULES (non-negotiable — deviation = reject the PR)

These rules exist because a security review found the original draft
ambiguous enough to permit dangerous implementations. Each rule is stated so
compliance is mechanically checkable.

### R1. No LLM in the write path — ever.
`submitOrder()` MUST be a direct, deterministic
`client.callTool({ name: "place_equity_order", arguments: {...} })` using
`@modelcontextprotocol/sdk`'s `Client` over `StreamableHTTPClientTransport`.
Arguments are built exclusively from the validated `trade_proposals` row and
`broker_accounts` — never from, through, or "confirmed by" any LLM. No LLM
output is ever parsed to derive order parameters, order status, or
`ok:true`. (Rationale: `trader/route.ts` already documents the
hallucinated-fill failure mode this prevents.)

### R2. The read path is ALSO deterministic by default.
The snapshot fetch calls `get_accounts` + `get_equity_positions` directly via
`callTool` and parses the structured results with a strict zod schema:
numbers must be finite, `symbol` must match `^[A-Z.\-]{1,10}$`, arrays
bounded (≤500 positions). No LLM is required to call two read tools. An LLM
summarizer MAY be layered on top for display text only, subject to R3.

### R3. LLM data-hygiene rules (applies to any optional summarizer).
- Vault tokens (`ROBINHOOD_MCP_*`), `CRON_SECRET`, and raw account numbers
  NEVER appear in any LLM prompt or LLM-visible tool argument. Account
  numbers are replaced with opaque labels ("Trading account") before
  prompting.
- MCP tool results are data, never instructions: the system prompt states
  this, and no numeric/actionable value from LLM output is written to any
  table. Loop iterations hard-capped.

### R4. OAuth 2.1 — do NOT copy the Kite route-pair internals.
Kite's callback runs unauthenticated with no `state` (fine for Kite's
checksum-signed flow, unsafe for OAuth). The Robinhood flow MUST have:
- `state`: ≥128-bit random, stored in an HttpOnly, Secure, SameSite=Lax,
  short-TTL (10 min) signed cookie; verified and single-use in the callback.
- PKCE S256; the verifier stored in the same signed cookie (serverless-safe
  — in-memory storage does not survive between `/login` and `/callback`
  invocations on Vercel).
- The callback REQUIRES an authenticated owner session
  (`createClient().auth.getUser()` + the middleware owner gate) before
  exchanging the code — prevents login-CSRF/token-injection.
- Exact registered `redirect_uri`, strict string compare. Post-auth redirect
  is HARDCODED to `/dashboard/settings?rhmcp=connected` — no `next` param.
- Request the MINIMUM scope set Robinhood offers. If read-only scopes exist,
  the snapshot connection uses only those; if only a bundled trading scope
  exists, that fact is surfaced in the Settings UI text.
- Related fix shipped alongside: `app/auth/callback/route.ts` must validate
  its `next` param (single leading `/`, no `//`, `\\`, or `@`) — current
  code allows `?next=@evil.com` open redirect.

### R5. Token handling.
- Tokens live only in `api_key_vault` (service-role-only as of migration
  089) and are sent only in the `Authorization` header — never in URLs,
  never logged, never included in `broker_orders.raw_last_state` (redact
  before persisting any `raw` payload; also redact account numbers).
- Refresh is single-writer: compare-and-swap on the vault row
  (`UPDATE ... WHERE updated_at = <value read>`), losers re-read instead of
  overwriting — prevents the rotating-refresh-token race between concurrent
  cron + user invocations from bricking the connection.

### R6. Gateway modifications (the Gateway is NOT "unchanged").
`app/api/broker/orders/route.ts` today lacks several gates the original
draft wrongly claimed it had. This feature MUST add, in order, before
`submitOrder`:
1. `guardOrderRequest(req)` (Host/Origin check) — extended to read the
   allowed host from an `APP_BASE_URL` env var so it works on Vercel
   (current guard allowlists localhost only; do NOT delete the guard to
   "fix" Vercel).
2. `env` MUST be explicitly present in the request body; reject if absent.
   No silent `?? "paper"` default on an order-placing route.
3. `broker.envs.includes(orderEnv)` checked in BOTH directions (a live-only
   broker rejects paper; a paper-only broker rejects live). The adapter
   additionally self-rejects wrong env (defense in depth).
4. `checkKillSwitches(supabase)` — kill switches currently run only at
   proposal build/approve, not at submission. They MUST also run here.
5. Existing checks retained: proposal `status='approved'`,
   `approval_expires_at`, global `trading_enabled` + per-market
   `trading_enabled_us`/`trading_enabled_india` (live env).
6. Submit-time re-validation (live env): `qty` positive integer ≤ hard cap;
   fresh quote fetched and `qty × quote ≤ max_order_notional` (new
   `strategy_config` column, default ≤15% of latest
   `live_account_snapshots.equity`); price drift vs
   `proposal.price_at_proposal` ≤ the same threshold `trader/route.ts` uses
   at approval; `symbol` matches `^[A-Z.\-]{1,10}$`; `side='sell'` allowed
   only if the symbol exists in the current holdings snapshot (long-only for
   new positions per CLAUDE.md).
7. Duplicate-submit hardening: partial unique index
   `broker_orders(proposal_id) WHERE status IN ('pending_submit',
   'submitted','partially_filled')` — the existing check-then-insert race
   allows double-submit on concurrent clicks.

### R7. Ambiguous-failure semantics (the case that duplicates real orders).
If `place_equity_order` times out or errors AFTER possibly succeeding, the
adapter MUST NOT resubmit. It marks the order row
`status='unknown_needs_reconcile'` and the sync loop (or a manual button)
calls `get_equity_orders` to reconcile before any human is allowed to retry.
Where Robinhood's MCP supports it, use `review_equity_order` → place
sequence and/or a client-order-id for idempotency. No automatic retry of
any write call, ever.

### R8. Account allowlist — fail closed, hardcode stays.
- Validation lives in BOTH the Gateway (before `submitOrder`) and inside
  `submitRobinhoodOrder()` (last code before the wire): resolved account
  must exist in `broker_accounts` with `role='trading'` and matching market.
- ANY error reading `broker_accounts`/`active_account_us` ABORTS the order.
  The silent fallback-to-default pattern used by `getActiveBroker()` for
  broker selection is explicitly FORBIDDEN for account selection.
- The existing hardcode (`AGENTIC_ACCOUNT = "605420660"` in
  `trader/route.ts`) is NOT removed in this feature. Removal is a separate,
  later change gated on the allowlist being verified live. Until then both
  checks run.
- New accounts default `role='view_only'`. Becoming a trading target
  requires BOTH explicitly setting `role='trading'` AND selecting it as
  `active_account_us`/`active_account_india`. No auto-discovery from broker
  APIs marks anything tradable.
- `broker_accounts` ships service-role-only (no anon/authenticated grants,
  no permissive policy) — a client-side writer to this table would defeat
  the entire allowlist. Migration must be verified applied to the live DB
  before the validation code merges (global schema rule).

### R9. Kill switches and flags (contradiction in prior draft resolved).
- `robinhood_mcp_enabled` (new, **default FALSE** — a live-order
  integration's kill switch must not ship pre-armed ON; user flips it on in
  Settings after connecting): when false, BOTH the MCP snapshot fetch and
  the MCP order path are blocked. The last cached snapshot in
  `live_account_snapshots` remains viewable — "blocked" means no new MCP
  calls, not hidden data.
- `trading_enabled_us` off: blocks live orders (all US brokers), never
  blocks any read.
- In-app Disconnect: deletes vault tokens even if Robinhood's revocation
  endpoint is unreachable (same contract as `disconnectKite()`), and the
  Settings UI states that Robinhood's own Agentic Trading dashboard is the
  authoritative, app-independent kill switch.

### R10. Cron/auth surface fixes shipped with this feature.
- New shared `verifyCronSecret(req)` helper using `crypto.timingSafeEqual`
  and rejecting when `CRON_SECRET` is unset/empty; used by the new routes
  (and the snapshot routes it touches). Repo-wide migration of the other
  ~30 `===` comparisons can follow separately.
- `GET /api/live-account/snapshot` currently returns live equity/positions
  with NO auth — it MUST require an authenticated owner session before this
  feature writes fresher data into it.
- The `robinhood_mcp` snapshot branch writes to `live_account_snapshots`
  directly via the service client — NOT via the existing loopback HTTP POST
  that ships `CRON_SECRET` to `NEXT_PUBLIC_APP_URL`.

## Scope

- OAuth 2.1 client per R4: `/api/robinhood-mcp/login` + `/api/robinhood-mcp/callback`.
- Token storage per R5 in `api_key_vault`.
- `lib/robinhood-mcp.ts`: OAuth helpers, vault-backed token storage/refresh
  (CAS), `queryRobinhoodAccount()` (read, R2), `submitRobinhoodOrder()`
  (write, R1/R7/R8 — called only by the broker adapter).
- `lib/brokers/robinhood-mcp.ts`: adapter implementing the standard
  interface (`id: 'robinhood_mcp'`, `envs: ['live']`, `isConfigured()`,
  `submitOrder()`), registered as a second US-market option.
- Gateway modifications per R6.
- `strategy_config.live_account_source` + Settings selector ("Local —
  Windows Scheduler + Claude Code" vs "Cloud — Robinhood MCP").
- `broker_accounts` table + `active_account_us`/`active_account_india` +
  Settings UI per R8 (manual add form: user types the account number and
  picks the role explicitly; no bulk import).
- Settings card "Robinhood MCP (Live Account + Orders)": connection status
  (`connected: boolean` + `updated_at` only — never token material),
  Connect/Re-authorize, Disconnect, `robinhood_mcp_enabled` toggle,
  `live_account_source` selector, authoritative-kill-switch note.

## Non-Goals

- **Any autonomous order placement.** Every order still requires (1) human
  Approve on the proposal, then (2) human "Send to broker" click. This
  feature changes transport for step 2 only.
- Removing the manual Claude-Code-paste flow (stays available: simply don't
  select `robinhood_mcp` as `active_broker_us`).
- Removing the `605420660` hardcode (separate later change, R8).
- Options trading: `place_option_order` is never called; the adapter
  supports equities only.
- Auto-discovery of accounts from broker APIs.
- Building the OAuth routes before the user has confirmed Robinhood's
  actual endpoints/scopes against the Agentic Trading dashboard.

## Data Models

- `api_key_vault`: `ROBINHOOD_MCP_ACCESS_TOKEN`, `ROBINHOOD_MCP_REFRESH_TOKEN` (service-role-only per migration 089 — already applied live).
- `strategy_config.live_account_source` — text, `'claude_exec' | 'robinhood_mcp'`, default `'claude_exec'`.
- `strategy_config.robinhood_mcp_enabled` — boolean, **default false** (R9).
- `strategy_config.max_order_notional` — numeric, default null → computed as 15% of latest live equity (R6.6).
- `strategy_config.active_account_us` / `active_account_india` — text, default today's hardcoded values.
- `broker_accounts` — `id, broker, market, account_number, label, role ('trading'|'view_only'), created_at`; service-role-only; seeded `605420660`→trading/us, `965848641`→view_only/us, current Kite account→india.
- `broker_orders` — new partial unique index per R6.7; new status value `unknown_needs_reconcile` (R7). RLS enabled + client grants revoked (migration 089 — already applied live).

## Error Handling

- Read-path MCP/OAuth failure → snapshot stays stale, `{ok:false, error}`
  logged (Decision 45 contract). Never throws away the cached snapshot.
- Write-path failure before the wire → order row `status='error'` with the
  real message. Possible-success ambiguity → R7 reconcile flow. No silent
  retry anywhere.
- Account/allowlist resolution failure → abort (fail closed, R8).

## Files / Behavior That Must Not Change

- Phase 0: proposals always `pending_approval`; auto-approve never permitted.
- Long-only enforcement for new positions; SELL only on held positions —
  now also enforced at Gateway submit time (R6.6).
- The existing `execClaude`-based mentor/portfolio/chart-data features.
- `trader/route.ts`'s manual-paste flow remains available and unchanged
  except for adding allowlist validation alongside (not replacing) the
  account hardcode.

## Acceptance Criteria (each is a hard review gate)

1. No code path derives order parameters or order status from LLM output
   (R1). Grep-level check: `place_equity_order` appears only inside
   `submitRobinhoodOrder()`, and that function contains no LLM call.
2. Snapshot fetch works with zero LLM calls (R2); any summarizer failure
   cannot block or alter stored numbers.
3. OAuth callback rejects: missing/mismatched `state`, replayed `state`,
   absent owner session (R4).
4. Tokens never appear in URLs, logs, LLM prompts, or persisted `raw`
   payloads (R5) — verified by grep + a redaction unit test.
5. Gateway rejects: absent `env`, env not in `broker.envs`, kill-switch
   tripped, notional over cap, price drift over threshold, sell of unheld
   symbol, account not in allowlist (R6, R8) — each with a unit test.
6. Ambiguous submit timeout produces `unknown_needs_reconcile`, never a
   resubmit (R7) — unit test with a mocked timeout.
7. `robinhood_mcp_enabled=false` blocks new MCP calls (read+write) while
   cached snapshot stays viewable; default is false (R9).
8. Disconnect wipes local tokens even when Robinhood is unreachable;
   Settings names Robinhood's own dashboard as the authoritative kill
   switch (R9).
9. `GET /api/live-account/snapshot` requires owner auth (R10).
10. Adding a `broker_accounts` row never makes it tradable without explicit
    `role='trading'` + active-account selection (R8).
11. All new tables/columns verified applied to the live DB before dependent
    code merges (global schema rule).

## Approval

Architecture approved: No
Approved scope: None
Implementation allowed: No
