# Feature Architecture: In-App Robinhood MCP Client (DeepSeek-driven, coexisting with the existing manual Claude Code flow)

## Status

Architecture status: Draft
Architecture approved: No
Approved scope: None
Approved date: None
Implementation allowed: No

## Feature Purpose

Today, refreshing the live Robinhood account snapshot (equity, buying power,
positions for the read-only Trading account `965848641`) depends on
`execClaude` (`lib/claude-exec.ts`), which shells out to a local Claude Code
CLI process with Robinhood MCP configured in the user's own `.claude.json`.
This only runs on the user's Windows machine — every invocation from
Vercel/cloud cron fails immediately (no PowerShell, no `claude.cmd` binary in
that environment). Since Windows Task Scheduler was disabled this session
(Decision 44), this snapshot has no working automatic refresh path at all.

This feature adds a second, in-app path: a direct MCP client (official
`@modelcontextprotocol/sdk`) connecting to Robinhood's real remote MCP server
(`https://agent.robinhood.com/mcp/trading`, confirmed via the user's own
`.claude.json` — `{"type":"http","url":"https://agent.robinhood.com/mcp/trading"}`),
driven by DeepSeek's tool-calling (DeepSeek's API is OpenAI/Anthropic
tool-calling compatible, confirmed via DeepSeek's own docs — no custom bridge
protocol needed), running server-side on Vercel. Read-only scope only, same
as `execClaude`'s current scope — this feature does not touch order placement.

## User/System Questions This Feature Answers

- How does the live Robinhood snapshot refresh once the local machine isn't
  required to be on/running Claude Code?
- Can the user still use the existing manual Claude-Code-paste flow if they
  prefer it, or does this feature force a migration?
- If the stored credential for this integration is ever suspected
  compromised, how does the user cut it off — from inside the app, and
  independently from inside Robinhood itself?

## Scope

This feature includes:
- A new OAuth 2.1 client (using `@modelcontextprotocol/sdk`'s `auth()` helper,
  which implements MCP's standard discovery/PKCE/token-exchange/refresh flow)
  connecting to Robinhood's MCP server, following the same route-pair pattern
  already used for Kite (`/api/kite/login` + `/api/kite/callback`):
  `/api/robinhood-mcp/login` (redirect to Robinhood's authorization endpoint)
  and `/api/robinhood-mcp/callback` (exchange code, store token).
- Token storage in the existing `api_key_vault` table (same pattern as
  `KITE_ACCESS_TOKEN`) — access token + refresh token + expiry.
- A runtime client: `experimental_createMCPClient` (Vercel AI SDK) or the
  official SDK's `StreamableHTTPClientTransport` directly, wired to
  `@ai-sdk/deepseek` (or `callLLM`'s existing DeepSeek routing) for the actual
  tool-calling loop ("get my positions and buying power").
- Replaces `execClaude` inside `fetchAndStoreAccountSnapshot()`
  (`lib/research-agent.ts`) — or, more likely, replaces the standalone
  `/api/live-account/refresh-snapshot` endpoint's implementation (decoupled
  from `execClaude` earlier this session) with this new client.
- **A first-class in-app kill switch** (see "Kill Switch Design" below).

## Non-Goals

This feature does not include:
- **Removing, deprecating, or replacing the existing manual Claude-Code-paste
  flow.** Both remain available as independent, user-choosable paths. The
  existing `execClaude`-based flow (used today for `mentor` ask/thesis/evaluate,
  `portfolio/robinhood`, `portfolio/live-holdings`, `chart-data`, and the
  order-execution instruction-paste flow in `trader/route.ts`) is untouched by
  this feature. The user can keep using their own interactive Claude Code
  session for any of these at any time, in addition to or instead of this
  in-app path.
- **Any change to live order execution.** `app/api/agents/trader/route.ts`'s
  manual-paste-into-Claude-Code flow for real orders on account `605420660`
  is explicitly out of scope and unchanged. This feature is read-only account
  data only (equity, buying power, positions) — CLAUDE.md's locked rule
  ("Running real TraderAgent orders without approval_required mode" requires
  pushback) applies with full force; nothing here proposes automating order
  placement via this new MCP client.
- **Storing the Robinhood OAuth token anywhere outside the existing vault
  pattern**, and no new credential-storage mechanism beyond what Kite already
  uses.
- Building this before the user has reviewed and confirmed the Robinhood
  Agentic Trading dashboard's actual auth requirements (the exact OAuth
  authorization/token endpoints, scopes, and whether the flow truly requires
  a desktop browser redirect the way Robinhood's docs state) — this document
  assumes the standard MCP OAuth 2.1 flow per spec, but Robinhood may have
  particulars (e.g., additional device-binding step) not yet confirmed against
  the actual dashboard.

## Kill Switch Design (explicit requirement from the user, not an afterthought)

Three independent layers, from least to most trustworthy:

1. **App-level pause flag** — `strategy_config` (or a new
   `robinhood_mcp_enabled` boolean) checked before every call this client
   makes. Fast, reversible, but only as trustworthy as this app's own code —
   insufficient alone.
2. **In-app "Disconnect" button** (Settings, same UI location/pattern as the
   Kite disconnect button added this session) — deletes the stored
   access/refresh token from `api_key_vault` AND calls Robinhood's OAuth
   token-revocation endpoint if one is exposed (to be confirmed against
   Robinhood's actual OAuth metadata — MCP's auth spec expects a
   `/.well-known/oauth-authorization-server` document that may list a
   revocation endpoint). Mirrors `disconnectKite()`'s "wipe locally
   regardless of whether the remote call succeeds" behavior — a failed
   network call to Robinhood must never leave a stale token looking
   "connected" in this app.
3. **Revoking from Robinhood's own Agentic Trading dashboard directly** — the
   authoritative kill switch. This works even if this app or its database
   were fully compromised, because the grant lives on Robinhood's side, not
   this app's. This must be documented prominently in the Settings UI (same
   as the Kite disconnect card now says for Zerodha) so the user always knows
   the real, unconditional way out regardless of what this app's code does.

Acceptance criteria for this feature explicitly include: (1) is there a working
in-app Disconnect action, (2) does it wipe the local token even if Robinhood's
API is unreachable, (3) does the Settings UI clearly state that revoking from
Robinhood's own dashboard is the authoritative, app-independent kill switch.

## Current Behavior

- `lib/claude-exec.ts`'s `execClaude()` shells out to `powershell.exe` +
  `claude.cmd` — Windows-desktop-only, throws immediately on Vercel.
- `fetchAndStoreAccountSnapshot()` (`lib/research-agent.ts`) used to fire
  automatically inside `gatherSymbols()`; decoupled this session into
  `/api/live-account/refresh-snapshot` (POST, cron-secret gated) so the user
  can control where it runs from (Decision 45 follow-up). It still uses
  `execClaude` internally — this feature is what would replace that
  internal implementation.
- Robinhood MCP today is configured only in the user's local
  `.claude.json` (`{"type":"http","url":"https://agent.robinhood.com/mcp/trading"}`)
  — confirmed real, remote, OAuth-authenticated (not a local stdio process).
- No credential for this exists anywhere in Supabase/`api_key_vault` today —
  this feature would be the first time a Robinhood-scoped token lives in this
  app's own storage, which is exactly why the kill-switch section above is
  written as a first-class requirement, not an add-on.

## Proposed Behavior

### 1. OAuth handshake
- `GET /api/robinhood-mcp/login` — begins the MCP OAuth 2.1 flow: discovery
  (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
  per MCP's auth spec), dynamic client registration if required, PKCE
  challenge, redirect to Robinhood's authorization page.
- `GET /api/robinhood-mcp/callback` — exchanges the authorization code (+ PKCE
  verifier) for an access token (and refresh token, if issued), stores both in
  `api_key_vault` (new key names, e.g. `ROBINHOOD_MCP_ACCESS_TOKEN` /
  `ROBINHOOD_MCP_REFRESH_TOKEN`, mirroring `KITE_ACCESS_TOKEN`'s pattern).
- Token refresh handled by the SDK's `auth()` helper when the stored token is
  near expiry, re-persisting the refreshed token to the vault.

### 2. Runtime snapshot fetch
- `/api/live-account/refresh-snapshot`'s implementation swaps from
  `execClaude` to: construct an MCP client (`StreamableHTTPClientTransport`
  pointed at `https://agent.robinhood.com/mcp/trading` with the stored
  bearer token) → list available tools → hand them to a DeepSeek tool-calling
  loop (`callLLM`'s existing DeepSeek routing, or `@ai-sdk/deepseek` directly)
  with a prompt equivalent to today's ("call get_equity_positions /
  get_accounts, return equity/buying_power/portfolio_value/positions as
  JSON") → parse the result → POST to `/api/live-account/snapshot` exactly as
  today.
- Runs identically whether triggered by pg_cron (cloud) or a local Windows
  Task — no longer environment-dependent, since it's a plain HTTPS call with
  no local process dependency.

### 3. Settings UI
- New card (Settings, next to the Kite card) — "Robinhood MCP (Live Account
  Read)": connection status, Connect/Re-authorize button, Disconnect button
  (per Kill Switch Design above), and the same "revoke from Robinhood's own
  dashboard is authoritative" note the Kite card now has.

## Screen / Page / Module Inventory

- `app/api/robinhood-mcp/login/route.ts` (new)
- `app/api/robinhood-mcp/callback/route.ts` (new)
- `app/api/robinhood-mcp/disconnect/route.ts` (new, mirrors `/api/kite/disconnect`)
- `lib/robinhood-mcp.ts` (new — OAuth client, token storage/refresh, MCP tool-call wrapper; mirrors `lib/kite.ts`'s shape)
- `app/api/live-account/refresh-snapshot/route.ts` (modify — swap `execClaude` for the new client)
- `app/dashboard/settings/page.tsx` (modify — new connection card)

## System Architecture

### Modules
- `lib/robinhood-mcp.ts` owns: OAuth flow helpers, vault-backed token
  storage/refresh, and a single `queryRobinhoodAccount()` function that runs
  the MCP-tools-via-DeepSeek loop and returns the same shape
  `fetchAndStoreAccountSnapshot()` already parses today (equity, buying_power,
  portfolio_value, position_count, positions[]) — so
  `/api/live-account/refresh-snapshot` barely changes its own code, just its
  data source.

### API Contracts
- `POST /api/robinhood-mcp/disconnect` → `{ ok: boolean, remoteInvalidated: boolean, error?: string }` (same shape as the new `/api/kite/disconnect`).

### Data Models
- `api_key_vault` — two new rows (`ROBINHOOD_MCP_ACCESS_TOKEN`,
  `ROBINHOOD_MCP_REFRESH_TOKEN`), no schema change (reuses the existing table,
  same as Kite).

### Error Handling
- Any MCP/OAuth failure degrades to: leave `live_account_snapshots` stale
  (exactly today's failure mode), log the real error (unlike `execClaude`'s
  historically-silent failures — Decision 45 already fixed
  `fetchAndStoreAccountSnapshot()` to return `{ok, error}` instead of `void`).

## Files / Behavior That Must Not Change

- `app/api/agents/trader/route.ts`'s manual-paste order-execution flow —
  completely untouched.
- The existing `execClaude`-based mentor/portfolio/chart-data features —
  untouched; they remain available on the user's local machine exactly as
  today.
- No change to which Robinhood account can place orders (`605420660` only,
  enforced today at the gateway level — this feature doesn't touch that gate
  at all since it never places orders).

## Acceptance Criteria

- User can still choose the manual Claude-Code-paste route for any
  Robinhood-related feature at any time — nothing is removed or gated behind
  this new integration.
- A working in-app Disconnect action exists for this integration before it
  ships, not as a follow-up.
- Disconnect wipes the local token even when Robinhood's revocation endpoint
  is unreachable.
- Settings UI states plainly that revoking from Robinhood's own dashboard is
  the authoritative, app-independent kill switch.
- This feature never proposes, and CLAUDE.md's push-back mandate applies if
  anyone later suggests, using this same MCP connection for automated order
  placement without a separately-approved architecture change.

## Approval

Architecture approved: No
Approved scope: None
Implementation allowed: No
