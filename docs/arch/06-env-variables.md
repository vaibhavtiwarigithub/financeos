# Kairos — Environment Variables
> 2026-09-14: **`BROKER_CREDENTIAL_KEY`** (server-only, required before any guest broker connection can be stored). The AES-256-GCM key material for `lib/security/credential-cipher.ts`, which encrypts per-user broker credentials in `user_broker_credentials`. Must be at least 32 characters — the module REFUSES to encrypt with a shorter or missing secret rather than accepting a weak key, so a guest connection simply cannot be created until it is set. Keep it out of the database: the point of envelope encryption here is that a database read alone is not enough to use someone's brokerage account, which fails if the key lives beside the ciphertext. Rotating it invalidates every stored credential (each guest must reconnect); the stored `v1.` envelope prefix exists so a future rotation scheme can tell versions apart.
> Last updated: 2026-09-14 (previously 2026-09-08)
> Update this file when: a new env var is added, an existing var is removed, a var moves to/from the vault, or default values change.

All secrets live in `.env.local` (gitignored) + Vercel environment variables for production.
The `api_key_vault` Supabase table holds runtime-editable keys — see `lib/vault.ts`.

> **Warning about encoding:** A UTF-8 BOM in `.env.local` causes the entire app to 500 at boot.
> If the app won't start after editing env, check the file encoding (must be UTF-8 without BOM).

---

## Required at startup (app won't boot without these)

```
NEXT_PUBLIC_SUPABASE_URL=         # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=    # Supabase anon key (public, safe)
SUPABASE_SERVICE_ROLE_KEY=        # Supabase service role (private — never expose to client)
ANTHROPIC_API_KEY=                # Claude API
CRON_SECRET=                      # Shared secret for Vercel cron + Task Scheduler auth
```

---

## Optional — features degrade gracefully without them

```
# Stripe (billing)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# Email
RESEND_API_KEY=
EMAIL_FROM=                       # e.g. "Kairos <hello@yourdomain.com>". Defaults to Resend's shared
                                  # onboarding@resend.dev, which may only mail the Resend ACCOUNT
                                  # OWNER's own address — inviting anyone else needs a verified domain.
RESEND_WEBHOOK_SECRET=            # Svix signing secret (whsec_...) from the Resend dashboard webhook.
                                  # Required by /api/webhooks/resend, which FAILS CLOSED without it:
                                  # unset means every delivery event is rejected 401 and bounces are
                                  # never recorded, so a dead invite address stays invisible. There is
                                  # deliberately no verification-skip flag.
BRIEFING_TO=                      # Email address that receives briefings (test mode: any address)

# LLM observability
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=                    # e.g. https://cloud.langfuse.com

# Vector / RAG (off if absent — no-ops silently)
JINA_API_KEY=          # free at jina.ai (no CC), 1M tokens/month

# Experiment tracking
WANDB_API_KEY=

# Robinhood MCP (OAuth token stored in vault at runtime)
ROBINHOOD_CLIENT_ID=              # From MCP dynamic registration
ROBINHOOD_CLIENT_SECRET=          # From MCP dynamic registration

# Provider adapter overrides (default to jina/resend if absent)
EMBEDDING_PROVIDER=               # jina (default) | openai
RERANK_PROVIDER=                  # jina (default) | cohere
EMAIL_PROVIDER=                   # resend (default) | smtp

# OpenAI (only needed if EMBEDDING_PROVIDER=openai)
OPENAI_API_KEY=

# Cohere (only needed if RERANK_PROVIDER=cohere)
COHERE_API_KEY=

# SMTP (only needed if EMAIL_PROVIDER=smtp)
# Gmail: smtp.gmail.com / 465 / the full address / a 16-char APP PASSWORD (needs 2FA —
# a normal account password is refused with 535 5.7.8). EMAIL_FROM must be that same
# mailbox or a verified alias, or Gmail rewrites/rejects the sender. This is the free way
# to mail someone other than the Resend account owner without verifying a domain.
# ORDER MATTERS: EMAIL_FROM and EMAIL_PROVIDER must flip TOGETHER with SMTP_PASS.
# EMAIL_FROM set to a gmail address while still on Resend 403s every send; EMAIL_PROVIDER
# =smtp without SMTP_PASS makes isAvailable() false and invites return 503.
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=

# USPS Address Standardization — property address verification (US only)
# Free developer account: https://developers.usps.com (create an app, enable the
# Addresses API). Both values are required; either one alone counts as absent.
USPS_CONSUMER_KEY=
USPS_CONSUMER_SECRET=
```

### USPS address verification behaviour without the credential

`lib/property/address-verify.ts` is **inert and honest** when `USPS_CONSUMER_KEY`
or `USPS_CONSUMER_SECRET` is missing: it makes no network call and returns
`not_configured` with the exact enable steps. The property UI shows
"Address verification is not configured" — never a green check and never a false
failure. An address that cannot be verified is flagged, never blocked from being
saved. India (`bengaluru`) is outside USPS coverage and returns `no_validator`;
no Indian address validator is wired. Persistent USPS outages open a single
System Health alert under `property-address-verify:usps`.

---

## Runtime-editable (stored in `api_key_vault` table, editable via `/dashboard/admin/vault`)

These keys are NOT in `.env.local`. They live in Supabase and are fetched at runtime via `lib/vault.ts`.

| Key name | Display name | Notes |
|---|---|---|
| `ALPHA_VANTAGE_API_KEY` | Alpha Vantage | Free tier: 25 calls/day; exhaustion fires System Health warn |
| `MASSIVE_API_KEY` | Massive Market Data | US candles + screener |
| `FMP_API_KEY` | FinancialDatasets | ResearchAgent screener candidates |
| `KITE_ACCESS_TOKEN` | Kite Access Token | Daily refresh required (SEBI mandate: expires 6 AM IST) |
| `ROBINHOOD_ACCESS_TOKEN` | Robinhood OAuth Token | CAS-protected refresh via `lib/robinhood-mcp-client.ts` |
| `ROBINHOOD_REFRESH_TOKEN` | Robinhood Refresh Token | Used to refresh access token before expiry |
| `WEBULL_MCP_*` (vault, `provider: webull_mcp`) | Webull Cloud MCP OAuth | `WEBULL_MCP_CLIENT_ID` / `_ACCESS_TOKEN` / `_REFRESH_TOKEN` / `_TOKEN_EXPIRES`. Written on the one-time OAuth connect (`/api/broker-mcp/webull/login`→`/callback`; legacy `/api/webull/*` 307-redirects there); CAS refresh in the config-driven `lib/brokers/mcp-driver.ts` (registry entry `MCP_BROKERS.webull`). Read-only (Phase 1). NOT env vars — vault rows |
| `STOCKTWITS_TOKEN` | StockTwits | Social sentiment for US tickers |

---

## Provider adapter env vars (added 2026-07-10)

| Var | Default | Options | Effect |
|---|---|---|---|
| `EMBEDDING_PROVIDER` | `jina` | `jina`, `openai` | Selects the embedding model used for RAG trade memory |
| `RERANK_PROVIDER` | `jina` | `jina`, `cohere` | Selects the reranker used after vector retrieval |
| `EMAIL_PROVIDER` | `resend` | `resend`, `smtp` | Selects the transport for briefing emails |

When `EMBEDDING_PROVIDER` or `RERANK_PROVIDER` is absent or set to `jina`, the Jina AI free
tier is used (1M tokens/month, no credit card required). When `JINA_API_KEY` itself is absent,
the entire RAG path silently no-ops — no errors, no embeddings, no retrieval.

---

## Where each key is used

| Key | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `lib/llm-router.ts` (Claude tiers) |
| `CRON_SECRET` | `lib/auth/cron.ts` → all cron routes |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/supabase/service.ts` → crons + admin ops |
| `ALPHA_VANTAGE_API_KEY` | `lib/av-cache.ts`, ResearchAgent, MacroSentinel, ThemeScout |
| `MASSIVE_API_KEY` | `lib/massive-data.ts` → US candles + screener |
| `FMP_API_KEY` | ResearchAgent screener (FinancialDatasets `screen_stocks`) |
| `KITE_ACCESS_TOKEN` | `lib/brokers/adapters/kite.ts` |
| `ROBINHOOD_ACCESS_TOKEN` | `lib/robinhood-mcp-client.ts` |
| `JINA_API_KEY` | `lib/providers/embeddings/jina.ts`, `lib/providers/rerank/jina.ts` |
| `RESEND_API_KEY` | `lib/providers/email/resend.ts` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | `lib/providers/email/smtp.ts` (only when `EMAIL_PROVIDER=smtp`) |
| `EMAIL_FROM` | `app/api/admin/access/route.ts` (invitation sender), `app/api/agents/user-risk-email/route.ts` |
| `RESEND_WEBHOOK_SECRET` | `lib/email/resend-webhook.ts`, `app/api/webhooks/resend/route.ts` |
| `LANGFUSE_*` | `lib/llm-router.ts` (Langfuse tracing) |
| `STRIPE_*` | `app/api/stripe/*` |
