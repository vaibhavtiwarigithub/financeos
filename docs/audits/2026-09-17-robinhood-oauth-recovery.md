# Robinhood OAuth recovery evidence

## Verified facts

- Production Robinhood account snapshots, including Agentic equity ending 0660, last advanced at 2026-09-16 21:00:09.939 UTC. Current configured source is `robinhood_mcp`; automatic live trading is off.
- September 17 cloud consent attempts ended on Robinhood's `/oauth/error`. The vault has client registration records but no access/refresh/expiry records. The cause of the earlier token removal is unknown.
- Robinhood support agent Daniel explicitly reported no restrictions on the Agentic account. The automated bot's earlier account-closure/crypto explanation is not an established cause.
- Commit `2107055e` (August 2) documents loopback callback recovery after the same remote-callback failure. Commit `0357620e` removed that rationale and the loopback registration on September 16. Neither comments nor a local passing contract test establish provider behavior today.
- Current authorization-server metadata advertises only the bundled `internal` scope. No equity-only OAuth scope or per-account authorization selector has been found. Do not close or disconnect a crypto account as a speculative fix.
- September 17 loopback registration for `http://127.0.0.1:53682/callback` returned HTTP 200 and that redirect URI. It returned the same public client ID as the cloud registration. A matching cached redirect list alone therefore does not prove a cloud callback will be accepted.

## Reproducible recovery

From the owner-controlled repository checkout with `.env.local` configured:

```
node --test scripts/robinhood-loopback-connect.test.mjs
node scripts/robinhood-loopback-connect.mjs
```

Open the printed Robinhood authorization URL and approve the fresh Robinhood device notification. The helper binds only to IPv4 loopback, uses random state and PKCE S256, validates Host/method/path and single-valued callback parameters, expires after ten minutes, and consumes state before exchange. It never exposes tokens in terminal output. Only after a complete token response does it save the client/access/refresh/expiry bundle in one vault upsert. It neither changes trading settings nor invokes order tools.

After authorization, verify token presence without returning token values; invoke the existing cloud `POST /api/live-account/refresh-snapshot` with server authentication and verify that the Agentic snapshot timestamp advances. A token alone is not proof of a successful MCP read, and a listed crypto order tool is not proof that Kairos implements live crypto execution.

## Verified recovery result

- Loopback authorization completed and all five credential-bundle records were saved at 2026-09-17 17:55:12.987 UTC. No crypto permission was removed.
- The browser subsequently showed `ERR_BLOCKED_BY_CLIENT` for the local result page, but the helper had already exchanged the code and saved the bundle. Verify server evidence rather than inferring authorization failure from that browser page.
- The existing deployed cloud collector, dispatched through `kairos_call_agent`, refreshed all six equity-account snapshots at 17:57:00.541 UTC, including Agentic ending 0660. No deploy was required for this restored cloud read.
- Authenticated `tools/list` exposes crypto onboarding, positions, quotes, orders, preview, place, and cancel tools. The read-only `get_crypto_account_onboarding_info` returned `already_onboarded: true`. This does not validate Kairos's live crypto order implementation.
- `live_auto_enabled` remains false. No order, preview, cancel, transfer, or account reactivation was requested.

This comparison supports a remote callback compatibility failure for the observed flow. It does not establish why the earlier vault tokens were removed, nor a universal Robinhood prohibition on all remote callbacks.
