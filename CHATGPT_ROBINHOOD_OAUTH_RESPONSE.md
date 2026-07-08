# Response — Robinhood Agentic Trading OAuth grant fails after consent + 2FA

Date: 2026-07-07  
Reviewed file: `CHATGPT_ROBINHOOD_OAUTH_ISSUE.md`  
Repo context checked: `AGENTS.md`, `WORK_LOG.md`, `PRD.md`, `knowledge/KNOWLEDGE_INDEX.md`, `knowledge/CONNECTIONS.md`, current `lib/robinhood-mcp.ts`, `/api/robinhood-mcp/login`, and `/api/robinhood-mcp/callback`.

## Short answer

The OAuth request is getting far enough that Robinhood recognizes the dynamically registered client, accepts the redirect URI syntactically, shows the real Agentic Trading consent screen, and completes phone approval. The failure happens inside Robinhood after consent, before redirecting back with an authorization code.

That strongly points to a Robinhood-side policy/gating failure rather than a normal OAuth parameter bug.

Most likely causes, ranked:

1. **Custom/self-registered dynamic clients are discoverable and can show consent, but are not currently allowed to complete grant issuance unless the client/platform is approved or trusted by Robinhood.**
2. **The account already has an active Claude/Robinhood MCP grant and Robinhood may allow only one active agent grant, or has a buggy conflict path when a second grant is attempted.**
3. **The redirect URI/domain is accepted early but rejected at final grant issuance because it is not a stable/approved/HTTPS-only domain.**
4. **The registered client metadata is incomplete for Robinhood’s final grant service, even though the RFC 7591 registration endpoint returns HTTP 200.**
5. **The account/agentic account state is not fully eligible for a second/custom connection despite the consent page listing the Agentic account.**

I would not keep iterating blindly in code. This is now an external-product question. The next practical path is a controlled test matrix plus Robinhood support/developer escalation.

---

## Confirmed facts from your test

These are strong evidence:

- Dynamic client registration succeeds at:
  `https://agent.robinhood.com/oauth/trading/register`
- Robinhood returns a `client_id`.
- Robinhood accepts the authorization request enough to render the real Agentic Trading consent screen.
- The consent screen lists the user’s accounts and the Agentic `•••0660` account.
- User can click Allow and pass phone approval.
- Robinhood then redirects to:
  `https://robinhood.com/oauth/error`
- The app callback is never hit.
- No `code`, `error`, `error_description`, or OAuth error query params are returned.

That means this is not a simple local callback bug. Your callback route cannot fix a flow where Robinhood never redirects to it.

---

## What Robinhood publicly documents

Robinhood’s public Agentic Trading product page says users can connect an AI agent to a Robinhood Agentic Account and that setup is through Robinhood’s MCP server. It describes the user-facing flow as pasting one MCP URL into an MCP config and funding a dedicated account. It also states users can disconnect the agent from the app.

Relevant public statements:

- Robinhood product page: “Market access for AI agents. Available now through Robinhood’s MCP server.”
- Same page: “Paste one URL into your MCP config to connect most agents out of the box.”
- Same page: “Connect your AI agent to a Robinhood Agentic Account…”
- Same page: “Set your agent up for trading in an account with a dedicated budget… and the option to disconnect anytime from directly in the app.”
- Robinhood support article says opening/authenticating the Agentic account is desktop-only and says to choose an AI platform and follow the applicable instructions.
- Robinhood support troubleshooting says if there are MCP connection issues, disconnect/reconnect the MCP on the AI platform; if the agent says the error is on Robinhood’s side, contact Robinhood.
- Robinhood newsroom says: “Bring your agents from anywhere and simply connect them to Robinhood’s AI-native Model Context Protocol (MCP) servers…”

Sources:

- Robinhood Agentic Trading product page: https://robinhood.com/us/en/agentic-trading/
- Robinhood Agentic Trading support overview: https://robinhood.com/us/en/support/articles/agentic-trading-overview/
- Robinhood newsroom launch post: https://robinhood.com/us/en/newsroom/robinhood-is-now-open-to-agents/

Important gap: I did not find public Robinhood documentation that explicitly says “custom RFC 7591 dynamic clients may complete authorization-code grants from arbitrary web apps.” The metadata exposes a registration endpoint, but the public docs are written around MCP clients/platforms, not custom in-app OAuth clients.

---

## Diagnosis by question

### 1. Why does Robinhood fail to issue the authorization code after consent + 2FA?

Likely because one of Robinhood’s internal final grant checks fails after the user approves.

Concrete likely causes:

#### A. Self-registered client is not fully trusted for grant issuance

Evidence:

- Registration endpoint returns a `client_id`.
- Consent page renders.
- But final grant issuance fails generically.
- Robinhood’s public docs speak in terms of connecting supported AI platforms/MCP clients, not building arbitrary embedded app OAuth clients.

Interpretation:

Robinhood may intentionally let dynamic registration and consent render for MCP compatibility, but still require an allowlisted/trusted client class to actually issue a grant. This would explain why validation passes until the final grant service.

This is currently the top hypothesis.

#### B. Existing Claude Code MCP grant conflicts with a second custom grant

Evidence:

- The same Robinhood account already has a working Claude Code/Desktop/CLI MCP connection.
- The consent screen lists the same Agentic account.
- The failure happens after consent, when Robinhood would create or attach a grant.

Interpretation:

Robinhood may support only one active agent connection per Agentic account, or may have a buggy second-grant path. Public docs mention an option to disconnect agents in the app, but do not document concurrent multiple agent grants.

This is plausible and testable.

#### C. Redirect URI is accepted early but rejected at grant commit

Evidence:

- Authorization request reaches consent, so the redirect URI is not rejected at the first validation layer.
- The registration includes both Vercel and localhost redirect URIs.
- The redirect URI used may be a Vercel preview/project hostname rather than a stable custom domain.

Interpretation:

Robinhood may perform a later anti-abuse/domain trust check that rejects:

- localhost in the same client registration,
- preview/deployment URLs,
- unverified Vercel subdomains,
- non-HTTPS redirect URIs,
- multiple redirect URIs,
- redirect URI not matching a canonical platform domain.

This would be poor OAuth ergonomics but is common in financial systems where different services own different validation steps.

#### D. Registered client metadata is insufficient

Registration response:

```json
{
  "client_id": "...",
  "client_name": "Robinhood Trading",
  "redirect_uris": [...],
  "token_endpoint_auth_method": "none"
}
```

Notable:

- Robinhood overrides `client_name`.
- No `registration_access_token`.
- No `client_secret`.
- No visible approval/verification state.

Possible internal issue:

- final grant service expects a platform identity, software statement, or metadata that the open registration endpoint does not require;
- endpoint is meant for MCP clients but not for persistent server-side apps;
- registration succeeds but is treated as unapproved.

#### E. Account state / eligibility problem

Less likely because the consent screen lists the Agentic account and 2FA completes, but still possible:

- Agentic account not fully funded/activated;
- account has a pending restriction;
- agentic feature still beta-gated;
- prior OAuth grant in an inconsistent state.

---

### 2. Is self-registered RFC 7591 dynamic client supported?

Confirmed:

- Robinhood exposes a dynamic registration endpoint.
- Your dynamic registration succeeds.
- The returned `client_id` reaches a real consent screen.

Not confirmed:

- That arbitrary self-registered clients are allowed to complete grant issuance.

My assessment:

**Dynamic registration is implemented, but successful registration alone does not prove arbitrary self-registered web apps are supported for final grant issuance.**

The generic post-consent failure strongly suggests there is a second layer of policy enforcement after consent. That layer may require:

- approved AI platform,
- known MCP client,
- whitelisted redirect/domain,
- one active agent connection,
- or some platform registration not exposed in the public metadata.

Do not assume this is supported until one custom client successfully receives an authorization code.

---

### 3. Is there a one-agent-per-account or single-active-grant limit?

I did not find public Robinhood docs stating the exact limit.

However, the issue is plausible because:

- Robinhood’s product model says the user connects “your AI agent” to a dedicated Agentic account.
- Public docs mention disconnecting the agent from the app.
- The user already has a working Claude Code MCP grant.
- The failure happens exactly when Robinhood would create/commit a grant.

Recommended test:

1. In Robinhood app/web, go to the Agentic Trading / Agentic account management area.
2. Look for connected agents/apps/MCP connections.
3. Disconnect the existing Claude Code / Claude Desktop / Robinhood Trading MCP connection.
4. Also remove/re-authenticate the MCP server from Claude Code if needed.
5. Retry the Kairos OAuth flow with a fresh dynamic client registration.

If the flow succeeds after removing Claude, the root cause is likely single-active-agent/grant conflict.

If it still fails, the root cause is likely custom-client/domain/platform gating.

Important: do this only if you are comfortable temporarily losing the existing working Claude MCP connection and can reconnect it.

---

### 4. Redirect URI constraints

Likely constraints:

- exact-match redirect URI;
- HTTPS required for deployed app;
- desktop browser required;
- stable domain may be expected;
- localhost may work only for recognized desktop MCP clients or only in dev contexts;
- preview Vercel URLs may be treated as suspicious.

Your current implementation registers:

```ts
[
  redirectUri,
  `${APP_BASE_URL}/api/robinhood-mcp/callback`,
  "http://localhost:3000/api/robinhood-mcp/callback"
]
```

Risk:

Registering localhost and production in the same client may pass registration but fail later policy checks.

Recommended test:

1. Use one stable production HTTPS callback only.
2. Use a stable custom domain if possible, not a Vercel preview hostname.
3. Delete stored `ROBINHOOD_MCP_CLIENT_ID`.
4. Re-register a new client with exactly one redirect URI:

```json
{
  "redirect_uris": [
    "https://your-stable-domain.com/api/robinhood-mcp/callback"
  ]
}
```

5. Retry OAuth from desktop browser.

Do not include localhost in the production client registration.

If you need local dev, register a separate local-only client ID.

---

### 5. Known-working references

#### Official Robinhood MCP path

Robinhood publicly documents the MCP URL flow, not a custom web-app OAuth integration flow. The public story is:

- Add Robinhood’s MCP URL to an AI platform/MCP client.
- Authenticate through Robinhood’s desktop onboarding/consent flow.
- Agent accesses only the dedicated Agentic account.

#### `verygoodplugins/robinhood-mcp`

The GitHub result is not a reference for Robinhood’s official Agentic Trading MCP OAuth. It is a read-only community MCP server wrapping unofficial Robinhood access. It does not prove official Robinhood Agentic Trading OAuth works for custom dynamic clients.

#### Hosted agent platforms

OpenClaw’s public guide says its setup is one URL into the platform’s MCP config and that the OAuth handshake occurs when the agent invokes a Robinhood tool. It does not document whether they use dynamic registration, a preapproved platform client, or a platform-specific provisioning path.

So: there is no public known-working reference proving a custom Kairos-style in-app dynamic client can complete grant issuance.

---

## Actionable next steps

### Step 1 — isolate redirect URI/domain as a variable

Use a stable HTTPS custom domain and one redirect URI only.

Implementation:

- Set `APP_BASE_URL=https://your-stable-domain.com`
- Delete `ROBINHOOD_MCP_CLIENT_ID` from the vault.
- Change registration during test to include only:

```ts
[
  "https://your-stable-domain.com/api/robinhood-mcp/callback"
]
```

- Retry OAuth from desktop.

Expected outcomes:

- If it succeeds: issue was redirect/domain/client metadata.
- If it fails: continue.

### Step 2 — test single-active-agent conflict

- Disconnect the existing Claude Code Robinhood MCP connection from Robinhood’s Agentic Trading management area.
- Retry Kairos OAuth with fresh client registration.

Expected outcomes:

- If it succeeds: Robinhood likely permits only one active agent grant or has a conflict bug.
- If it fails: continue.

### Step 3 — contact Robinhood with a precise support packet

Send Robinhood support/developer support:

- timestamp with timezone of failed attempt;
- Robinhood account email;
- masked Agentic account `•••0660`;
- dynamic `client_id` prefix/last 6 only, not full if you prefer;
- redirect URI used;
- exact final URL: `https://robinhood.com/oauth/error`;
- statement that registration succeeds and consent+2FA pass, but code is never issued.

Ask directly:

1. Are RFC 7591 self-registered clients allowed to complete Agentic Trading OAuth grants?
2. Are custom web apps allowed, or only approved MCP client platforms?
3. Is there a one-active-agent or one-active-grant limit per Agentic account?
4. Are Vercel/localhost redirect URIs blocked at grant issuance?
5. Does the client require allowlisting or a software statement?

### Step 4 — keep live orders disabled until a code is issued

Do not keep changing the trading execution code to work around this. The app cannot use Robinhood MCP in-app until Robinhood issues an authorization code and token.

Keep:

- `robinhood_mcp_enabled=false`
- manual Claude Code MCP flow available
- deterministic gateway hardened
- no LLM in order write path

---

## Recommended app behavior if Robinhood confirms custom clients are unsupported

If Robinhood says custom self-registered clients cannot complete the grant:

1. Remove or hide the in-app Connect button behind a feature flag.
2. Keep the manual Claude Code MCP path as the only Robinhood execution path.
3. Keep the Execution Gateway hardening because it still benefits Alpaca/Kite and future brokers.
4. Add a Settings note:

> Robinhood currently supports Agentic Trading through approved MCP clients/platforms. Kairos can generate and approve proposals, but direct in-app Robinhood MCP execution is disabled until Robinhood supports custom app OAuth grants or provides partner approval.

5. Consider using Alpaca paper/live for fully in-app execution while preserving Robinhood as a manually approved MCP path.

---

## Recommended app behavior if it is a one-agent conflict

If disconnecting Claude makes Kairos OAuth work:

1. Add a Settings warning:

> Robinhood may allow only one active Agentic Trading connection per Agentic account. Connecting Kairos may disconnect or conflict with Claude/Codex/Cursor connections.

2. Add a pre-connect checklist:

- disconnect existing Robinhood MCP agent in Robinhood app;
- reconnect through Kairos;
- verify account shown is `•••0660`;
- keep `robinhood_mcp_enabled=false` until the first snapshot and tool schema verification pass.

3. Store the connected client/platform name and timestamp in the app so this is visible later.

---

## Recommendation for Claude / Builder

Do not treat this as a code bug until the two controlled tests are run:

1. fresh registration with exactly one stable HTTPS redirect URI;
2. same test after disconnecting existing Claude Robinhood MCP grant.

If both fail, stop implementation work and mark in-app Robinhood MCP OAuth as externally blocked pending Robinhood support/partner approval.

The codebase should keep the existing safe posture:

- no live orders without manual approval;
- no LLM in order write path;
- Robinhood MCP disabled by default;
- manual Claude Code path remains available;
- Alpaca/Kite remain the practical in-app broker paths until Robinhood OAuth is resolved.

## Bottom-line verdict

The failure is real and probably not caused by the app callback. The most likely explanations are:

1. Robinhood does not currently allow arbitrary self-registered custom clients to complete Agentic Trading grants, even though registration and consent can start; or
2. Robinhood blocks/conflicts on a second active agent grant because Claude Code is already connected; or
3. Robinhood’s final grant service rejects the redirect/domain/client metadata only after consent.

The fastest way to distinguish them is:

1. re-register with a single stable HTTPS custom-domain redirect;
2. retry after disconnecting existing Claude MCP;
3. if still failing, escalate to Robinhood with the support packet above.
