# Diagnose: Robinhood Agentic Trading OAuth fails at grant issuance (custom client)

I'm building an in-app integration to Robinhood's **Agentic Trading MCP** server
using its OAuth 2.1 flow. The consent screen renders correctly and 2FA passes,
but Robinhood then shows a generic error and never issues an authorization code.
I need you to figure out **why Robinhood refuses to complete the grant**, and
whether a self-registered (RFC 7591 dynamic) OAuth client is even supported for
Robinhood Agentic Trading — or if it requires an approved/whitelisted agent
platform, or if there's a one-agent-per-account conflict.

## Verified facts (all confirmed by direct testing, not assumptions)

**MCP server:** `https://agent.robinhood.com/mcp/trading`

**OAuth metadata** (fetched live from `https://agent.robinhood.com/.well-known/oauth-authorization-server`):
- authorization_endpoint: `https://robinhood.com/oauth`
- token_endpoint: `https://api.robinhood.com/oauth2/token/`
- registration_endpoint: `https://agent.robinhood.com/oauth/trading/register`
- scopes_supported: `["internal"]`
- grant_types_supported: `["authorization_code","refresh_token"]`
- response_types_supported: `["code"]`
- code_challenge_methods_supported: `["S256"]`
- token_endpoint_auth_methods_supported: `["none"]` (public client)
- issuer: `https://agent.robinhood.com/mcp/trading`

Protected-resource metadata (`.well-known/oauth-protected-resource?resource=…/mcp/trading`):
- authorization_servers: `["https://agent.robinhood.com/mcp/trading"]`
- bearer_methods_supported: `["header"]`
- resource: `https://agent.robinhood.com/mcp/trading`
- scopes_supported: `["internal"]`

**1. Dynamic client registration SUCCEEDS.** POST to the registration_endpoint:
```
POST https://agent.robinhood.com/oauth/trading/register
Content-Type: application/json
{
  "client_name": "Kairos FinanceOS",
  "redirect_uris": ["https://<app>.vercel.app/api/robinhood-mcp/callback","http://localhost:3000/api/robinhood-mcp/callback"],
  "grant_types": ["authorization_code","refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "internal"
}
```
Response HTTP 200:
```
{"client_id":"<40-char id>","client_name":"Robinhood Trading","redirect_uris":[...same...],"token_endpoint_auth_method":"none"}
```
Note Robinhood OVERRODE client_name to "Robinhood Trading" and returned no
client_secret (public client). No client_secret_expires_at, no registration
access token.

**2. Authorization request reaches a REAL consent screen.** We redirect the
browser to:
```
https://robinhood.com/oauth?response_type=code&client_id=<id>&redirect_uri=<encoded app callback>&scope=internal&state=<random>&code_challenge=<S256>&code_challenge_method=S256&resource=https%3A%2F%2Fagent.robinhood.com%2Fmcp%2Ftrading
```
Robinhood internally serves the consent at `https://robinhood.com/mcp/trading?...(same params)`.
The consent page renders correctly, listing all the user's accounts and
specifically the **Agentic ••• 0660** account, with permissions ("place trades
in your agentic account", positions/orders/balances/PNL, manage watchlists) and
an **Allow** button. So the client_id is recognized, redirect_uri accepted,
scope + PKCE + resource all accepted.

**3. After clicking Allow + approving the phone 2FA** (which says "we recognize
this device"), Robinhood redirects to its OWN error page:
```
https://robinhood.com/oauth/error
Title: "OAuth | Robinhood"
Body: "Uh oh! Something's gone wrong. An unexpected error occurred while
connecting this application to Robinhood."
```
No error query params, no error code, no detail. It does **NOT** redirect to
our redirect_uri — so no authorization code is ever issued. Our callback is
never hit. This happened on **two clean single-flow attempts** (no competing
tabs, fresh state each time).

**4. Possibly relevant:** the same Robinhood account ALREADY has Robinhood MCP
connected via a Claude Code (Claude Desktop / CLI) MCP integration configured in
the user's local `.claude.json` (`{"type":"http","url":"https://agent.robinhood.com/mcp/trading"}`).
So there may already be an active agent grant on this account.

## What I need from you

1. **Why does Robinhood fail to issue the authorization code** after consent +
   2FA succeed, with a generic error? Enumerate the concrete likely causes.
2. **Is a self-registered RFC 7591 dynamic client supported** for Robinhood
   Agentic Trading, or does the grant require an approved/partner agent
   platform (e.g., Claude, and the third-party agents Robinhood lists)? If the
   registration endpoint is open but the grant is gated, say so.
3. **Is there a one-agent-per-account or single-active-grant limit** that would
   make a second connection error while a Claude Code MCP grant already exists?
   How would the user check/remove existing connected agents (Security & Privacy
   settings / agentic account page)?
4. **redirect_uri constraints** — does Robinhood require a verified/allowlisted
   domain, HTTPS only, exact-match, no wildcard/preview URLs? Could a Vercel
   project-style hostname (`<proj>-<hash>.vercel.app` vs a stable custom domain)
   trip a validation that only fails at grant time?
5. **Any known-working reference** — how do existing integrations
   (`verygoodplugins/robinhood-mcp`, Truthifi, or Robinhood's documented agent
   partners) actually obtain the token? Do they use dynamic registration + this
   same authorize/token flow, or a different provisioning path?
6. **Actionable fix or definitive blocker** — tell me either the specific change
   that makes the grant succeed, or state clearly that custom self-registered
   clients cannot complete this flow and the only supported path is via an
   approved agent platform (in which case the app should keep using the existing
   manual Claude-Code flow and not pursue in-app MCP orders).

Please cite Robinhood's actual agentic-trading / API developer docs where
possible, and distinguish confirmed facts from inference.

---
**Write your answer to:** `CHATGPT_ROBINHOOD_OAUTH_RESPONSE.md`
