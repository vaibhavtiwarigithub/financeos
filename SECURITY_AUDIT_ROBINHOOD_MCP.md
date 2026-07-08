# Security Audit — Robinhood MCP Live-Trading Integration

Full adversarial security review of the Robinhood MCP real-money order path,
OAuth/token handling, auth/request surface, and secrets/data exposure. Findings
are written so a small model can fix each one **mechanically** — exact file,
exact line(s), exact change. Ordered most-severe first. Fix in this order.

**Overall:** the live-order path itself is well-layered and fail-closed (owner
gate → CSRF guard → env-explicit → allowlist → kill switch → notional cap →
price drift → held-qty). The serious issues are (a) two database RLS gaps that
leak sensitive data to the public anon key, and (b) two order-correctness gaps
that can double-place or place a wrong-side order.

---

## CRITICAL

### C1 — `app_settings` table readable/writable by the public anon key → leaks the vault PIN
- **Where:** Supabase database (RLS policy), consumed by `app/api/admin/vault/route.ts:16-17, 100-110`.
- **Issue:** `app_settings` has grants to `anon`/`authenticated` and a policy `service_only` written as `qual = true` (which *grants* access to everyone, it does not restrict). The vault PIN is stored there as plaintext (`key='vault_pin'`).
- **Why it matters:** `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships in the browser JS bundle. Anyone can run `supabase.from('app_settings').select()` and read the PIN, or `UPDATE` it to lock the owner out / plant a known PIN.
- **Fix (apply as a new migration + run on prod):**
  ```sql
  revoke all on table app_settings from anon, authenticated;
  drop policy if exists service_only on app_settings;
  ```
  All app writes use the service client, so this is non-breaking. This is the exact pattern migrations 042/089 already applied to the other vault tables — `app_settings` was missed.

### C2 — `live_account_snapshots` readable by anon/authenticated → leaks live equity, buying power, full positions
- **Where:** Supabase database (RLS), gate bypassed relative to `app/api/live-account/snapshot/route.ts`.
- **Issue:** same `anon/authenticated` grants + `service_all` policy with `qual = true`.
- **Why it matters:** any browser session (or the anon key alone) reads `live_account_snapshots` directly via supabase-js, bypassing the `requireOwner()` gate — full live brokerage balances + positions exposed.
- **Fix (same migration):**
  ```sql
  revoke all on table live_account_snapshots from anon, authenticated;
  drop policy if exists service_all on live_account_snapshots;
  ```

> **Note for the fixer:** put C1 + C2 in one migration file `supabase/migrations/102_lock_rls_gaps.sql`, then apply it to prod. Verify with:
> `select tablename, grantee, privilege_type from information_schema.role_table_grants where tablename in ('app_settings','live_account_snapshots') and grantee in ('anon','authenticated');` → should return zero rows.

---

## HIGH

### H1 — Ambiguous order-place failure is classified as a clean failure → double-place risk
- **Where:** `lib/robinhood-mcp.ts:417-424` (submit) + `app/api/broker/orders/route.ts:238` (gateway status write).
- **Issue:** only a *thrown* exception or a missing order id yields `needsReconcile`. But `mcpRpc` turns post-send ambiguity (HTTP 5xx after the request reached the server ~line 270, HTTP 200 with unparseable body ~271, response-id mismatch ~275) into `ok:false`. That hits `if (!place.ok)` → gateway writes `status:"error"`, which is NOT in the migration-095 dup-index → the proposal is immediately resubmittable.
- **Why it matters:** Robinhood accepts the order, its proxy returns 502, the retry places a **second real order**.
- **Fix:** in `mcpRpc`, return a `sent: boolean` flag (true once the HTTP request was transmitted, i.e. for HTTP-status errors, unparseable/empty body, and id mismatch — false only for a JSON-RPC `error` object or `result.isError`, which are definite server-side rejections). In `submitRobinhoodOrder` around line 424, when `place.ok === false && place.sent === true`, return `{ ok:false, needsReconcile:true, ... }` instead of a plain failure. The gateway already maps `needsReconcile` → `unknown_needs_reconcile` (which IS in the dup index), so no gateway change needed.

### H2 — Review-echo verification never checks SIDE, account, or order type
- **Where:** `lib/robinhood-mcp.ts:439-447` (`reviewEchoMismatch`).
- **Issue:** it only verifies symbol (weak substring, only if the literal word "SYMBOL" appears) and qty. It does **not** verify `side`, `account`, or `type`. A `review_equity_order` response echoing SELL when BUY was intended passes the check and proceeds to `place_equity_order`.
- **Why it matters:** a wrong-side (or wrong-account, wrong-type) real order is placed with no guard.
- **Fix:** parse the review content with `mcpToolJson` first. When a `side` field is present, require it to equal `o.side` (case-insensitive) — add a `\b(BUY|SELL)\b` regex fallback for text previews and fail if it finds the opposite side. When an `account_number`/`account` field is present, require it to equal the intended account. When a `type` field is present, require it to equal `o.type`. Tighten the symbol match to a word boundary (`new RegExp(\`\\b${escapeRegex(o.symbol)}\\b\`, 'i')`). Return a mismatch string on any disagreement.

---

## MEDIUM

### M1 — Token-refresh CAS window: two refreshers can reuse the same refresh token → bricked connection
- **Where:** `lib/robinhood-mcp.ts:174-210` (`refreshAccessToken`).
- **Issue:** the compare-and-swap only excludes callers who read `updated_at` before the winner's claim. A caller reading the row *after* the claim but *before* `storeTokens` completes (~1-15s network window) passes its own CAS and calls the token endpoint with the OLD refresh token. If Robinhood rotates+invalidates refresh tokens on reuse, the connection bricks (needs manual re-auth).
- **Why it matters:** overlapping crons (order-sync + account-snapshot) both hitting the 60s pre-expiry refresh window trigger it.
- **Fix:** after reading `updatedAt` (~line 177), add: `if (updatedAt && Date.now() - Date.parse(updatedAt) < 30_000) return { ok: false, error: "refresh in flight — retry" };` — treat a row whose `updated_at` is younger than 30s as a refresh already in progress and do not claim.

### M2 — Refresh-CAS loser returns a stale/expired token as success
- **Where:** `lib/robinhood-mcp.ts:189`.
- **Issue:** the CAS loser returns `{ ok: true }` immediately; `getValidAccessToken` (~line 231) then re-reads the still-old access token (winner hasn't stored the new one yet) and proceeds with a token that 401s.
- **Fix:** at line 189, replace `return { ok: true };` with `await new Promise(r => setTimeout(r, 3000)); return { ok: true };` (give the winner time to store), or return `{ ok:false, error:"refresh in flight — retry" }`.

### M3 — Rotated refresh token stored last; a failed write loses it permanently
- **Where:** `lib/robinhood-mcp.ts:139-145` (`storeTokens`).
- **Issue:** access token written first, refresh second. If the refresh-token `vaultSet` throws after Robinhood already rotated (old refresh now invalid), the new refresh token is lost → bricked.
- **Fix:** in `storeTokens`, move the refresh-token write (line 141 `if (tok.refresh_token) ...`) ABOVE the access-token write (line 140) so the refresh token persists first.

### M4 — `robinhoodHeldQty` sell-gate: unescaped symbol regex + 200-char window + all-accounts fallback
- **Where:** `lib/robinhood-mcp.ts:529, 543`.
- **Issue:** (a) line 543 interpolates `sym` into a regex unescaped, and `SYMBOL_RE` allows `.` (e.g. BRK.B) so `.` matches any char → can hit the wrong position row; (b) the `{0,200}` window can run into the next position's `quantity`; (c) line 529: if the account filter matches zero rows it falls back to ALL positions — shares on the read-only account 965848641 could satisfy a sell gate for trading account 605420660.
- **Why it matters:** the gateway could approve a SELL of shares not actually held on the trading account.
- **Fix:** (a) escape regex metachars in `sym` before interpolation (`sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`); (c) when `account` was supplied and `filtered.length === 0`, return `{ ok:true, qty:0 }` instead of falling back to all positions.

### M5 — `extractOrderId` fallback regex can capture the wrong id
- **Where:** `lib/robinhood-mcp.ts:467-469`.
- **Issue:** on JSON-parse failure, `/"(?:order[_-]?id|id)"\s*:\s*"([0-9A-Za-z-]{8,})"/` grabs the FIRST bare `"id"` in the text — could be an instrument/account/request id. A wrong id → sync loop matches nothing (stuck) or matches a different historical order and copies its fill state.
- **Fix:** first pass matches only `order[_-]?id`; only if that finds nothing, fall back to bare `"id"` AND require it to appear exactly once; require UUID shape `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`.

### M6 — Order-place path missing account-pinning fail-closed
- **Where:** `lib/robinhood-mcp.ts:324-327`.
- **Issue:** `account` is added to the wire args only if the discovered schema has an account property, else silently dropped. Combined with H2 (no account echo check), an account-less order lets the server pick a default.
- **Fix:** after `buildArgsFromSchema` for the place call, if `canonical.account` was provided but no account key landed in `out`, return a fail-closed error (`{ ok:false, error:"account could not be pinned to order args" }`). Also add account to the H2 echo check.

### M7 — `guardOrderRequest` cron-secret bypass skips Host + Origin checks
- **Where:** `lib/request-guards.ts:46`.
- **Issue:** a valid `x-cron-secret` skips both Host and Origin checks. The CRON_SECRET lives in pg_cron job definitions + `.env.local`. It's belt-loosening (requireOwner still runs first on the order route), not a standalone hole.
- **Fix:** remove the cron-secret bypass from `guardOrderRequest`; cron-legit routes already call `verifyCronSecret` themselves.

### M8 — No Origin header passes `guardOrderRequest`
- **Where:** `lib/request-guards.ts:55`.
- **Issue:** `origin !== null && !ALLOWED_ORIGINS.has(origin)` → a request with **no** Origin header passes. Browsers always send Origin on cross-site POST (so classic CSRF still fails), but a non-browser client replaying a stolen cookie sails through.
- **Fix:** on non-GET methods, require Origin to be present AND allowlisted — treat missing Origin as 403.

### M9 — `broker-accounts` POST (sets `role:'trading'`) missing `guardOrderRequest`
- **Where:** `app/api/broker-accounts/route.ts:21-29`.
- **Issue:** owner-gated but not CSRF-guarded, and it controls which accounts can receive live orders (the allowlist).
- **Fix:** add `const g = guardOrderRequest(req); if (g) return g;` right after the `requireOwner()` check in POST.

### M10 — No rate limit on the order endpoints
- **Where:** `app/api/broker/orders/route.ts` (before insert ~line 210) + `app/api/kite/order/route.ts` (before insert ~line 66).
- **Issue:** notional cap + kill switch + dup-index are the only backstops; nothing caps orders-per-minute. A stolen owner cookie could fire every approved proposal in seconds.
- **Fix:** before the `broker_orders` insert, count rows inserted in the last 10 minutes and reject if over a threshold (e.g. `select count(*) from broker_orders where submitted_at > now() - interval '10 minutes'` → if > 10, return 429).

### M11 — Token JSON can be serialized into an error string
- **Where:** `lib/robinhood-mcp.ts:118, 164`.
- **Issue:** `JSON.stringify(json).slice(0,300)` on the token-endpoint response goes into the returned `error`. A 200 response containing `access_token`/`refresh_token` alongside an error field would embed token material.
- **Fix:** before stringifying, strip token fields: `JSON.stringify({ ...json, access_token: undefined, refresh_token: undefined })`. Also extend `redact()` (line 475) to also strip `"(access|refresh)_token"\s*:\s*"[^"]+"`, not just `Bearer …`.

### M12 — `trader` approve/reject route accepts any authenticated user
- **Where:** `app/api/agents/trader/route.ts:48-52`.
- **Issue:** proposal approve/reject is gated on any authenticated user, not `requireOwner`. Only middleware's owner-signout currently prevents a second user from approving (the precondition for the owner-gated Gateway submit).
- **Fix:** replace the any-auth check with `const gate = await requireOwner(); if (!isCron && gate) return gate;` (preserve the existing cron path if one exists).

---

## LOW

### L1 — Vault PIN compared with `!==` (not timing-safe)
- **Where:** `app/api/admin/vault/route.ts:33, 67`.
- **Fix:** compare via `crypto.timingSafeEqual` over equal-length buffers (hash both sides first to equalize length).

### L2 — `localhost:3000` redirect URI registered in production
- **Where:** `app/api/robinhood-mcp/login/route.ts:20`.
- **Fix:** wrap the localhost redirect entry so it's only included when `process.env.NODE_ENV !== "production"`.

### L3 — OAuth state cookie scoped to `path:"/"`
- **Where:** `app/api/robinhood-mcp/login/route.ts:34` (+ callback delete at callback:20).
- **Fix:** change `path:"/"` to `path:"/api/robinhood-mcp"` in both the set and the delete.

### L4 — Adapter has no last-mile qty guard
- **Where:** `lib/brokers/adapters/robinhood-mcp.ts:34-41`.
- **Fix:** add `if (!Number.isInteger(o.qty) || o.qty <= 0) return { ok:false, error:"invalid qty" };` mirroring the existing env check.

### L5 — `timeInForce` fails open on enum mismatch
- **Where:** `lib/robinhood-mcp.ts:340-343`.
- **Fix:** when the tif enum coercion yields `undefined` and the field isn't required, skip the field instead of sending the raw value.

### L6 — requireOwner pins email only, not user id
- **Where:** `lib/auth/owner.ts:5`, `lib/auth/require-owner.ts:11-13`.
- **Fix:** also assert `user.email_confirmed_at` is set (or additionally pin the owner's Supabase `user.id`), so an unverified-email registration of the owner's address can't pass.

### L7 — Vault UI returns masked token prefixes for `robinhood_mcp` rows
- **Where:** `app/api/admin/vault/route.ts:37-46`.
- **Fix (optional):** suppress `key_value`/`env_masked` entirely for `provider='robinhood_mcp'` rows.

---

## Verified clean (no action)
- OAuth flow: state HMAC-verified with `timingSafeEqual` + expiry; PKCE verifier only in the signed HttpOnly/Secure/SameSite=Lax/600s cookie; callback deletes cookie on every exit (single-use, replay-safe); post-auth redirect hardcoded (no open redirect).
- `OAUTH_STATE_SECRET` fail-closed in prod (throws if unset/short); no CRON_SECRET/service-key fallback.
- RLS correct on `api_key_vault`, `broker_orders`, `broker_accounts` (service-role only, verified live).
- Tokens sent only in `Authorization: Bearer` headers and POST bodies — never in URLs/query params.
- MCP/OAuth endpoint URLs are hardcoded module constants (not env-driven) → no SSRF-by-config.
- `buildArgsFromSchema` fails closed on unknown required fields; qty never aliases to a dollar `amount`; side/type enum coercion fails closed.
- Kill-switch / enable-flag / allowlist checks run before any order network call; `place_equity_order` reachable only via gateway → adapter → submit; no cron path reaches live-order placement.
- Dup-submit unique index (mig 095) blocks concurrent double-click and resubmit for `pending_submit/submitted/partially_filled/unknown_needs_reconcile` (the gap is `error` status — see H1).
- `.env*` gitignored; no secret ever committed; `OAUTH_STATE_SECRET` default never committed.
- Account numbers render masked (`••••0660`) client-side; full number only in confirm dialogs + server code.
