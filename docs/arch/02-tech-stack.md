# Kairos — Tech Stack
> 2026-07-31: **Daily scoring now has a provider-independent completed-session boundary.** Yahoo is the current primary US daily-candle source and the India fallback behind Upstox; after normalization, ResearchAgent removes the current market-local bar until 16:00 ET / 15:30 IST. The separate Yahoo deep-history adapter remains an offline/replay input and does not authorize strategy promotion.
>
> 2026-07-31: **Reported fundamentals are event-aware and ADR-safe.** ResearchAgent batch-reads `earnings_calendar` before provider work: a report in the prior 3 or next 14 days uses a 1-day cache; otherwise or when unknown it uses 7 days. Finnhub issuer profiles use 30 days. Theme Scout validates candidates with a quote, never a full fundamentals fetch. Reviewed exchange-listed ADRs use Yahoo ADS-basis fundamentals only; an unavailable ADR response cannot fall through to a provider that resolves the foreign ordinary share.
> 2026-07-28: Yahoo daily candles became market-agnostic in `lib/data/yahoo-candles.ts` (`fetchYahooCandles` + `yahooRange`). Measured five-year depth: AAPL 1254 bars and RELIANCE.NS 1239 bars. This is the free keyless deep-history fallback when Massive's entitlement rejects older US history. Range boundaries guarantee the returned window is not shorter than requested.
> Last updated: 2026-07-22 (Yahoo Finance v8 chart promoted to **primary US candle** source; recency guard added to `fetchUsCandles`; `minCandles` default raised 15→60; Massive/EODHD/TwelveData demoted to fallback)
> Prior: 2026-07-19 (`webull_trade` signed sender restored behind database-backed preflight and nine-gate one-shot permits; adapter and activation remain DISABLED; read-only Cloud MCP remains query-only)
> Prior: 2026-07-16 (House Stock Watcher congressional feed retired — upstream bucket went private; no licence-clean free replacement qualified)
> Update this file when: a new library is added, a provider changes, a new adapter is added, the framework is upgraded, or any layer in the table below changes.

---

## 1. Frontend + framework

| Layer | Technology | Notes |
|---|---|---|
| Framework | **Next.js 15** (App Router) | All pages under `app/`; both RSC and client components |
| Language | **TypeScript** (strict) | Centralized types at `@/types` |
| Styling | **Inline styles + T tokens** | No Tailwind, no CSS modules. Each file declares `const T = { bg, surface, card, border, text, ... }`. Never add external class utilities. |
| Charts | **Recharts** | Used for paper P&L, score history, correlation charts |
| Diagrams | **Mermaid v10** | v11 webpack-broken; agent flowcharts rendered by `components/dashboard/MermaidChart.tsx` |
| TradingView | **Advanced Chart widget** | Sector ETF charts on Markets page; symbol detail page |
| Fonts | JetBrains Mono (monospace for numbers/code) | Loaded as system font fallback |

---

## 2. Backend + data

| Layer | Technology | Notes |
|---|---|---|
| Database | **Supabase (PostgreSQL)** | All tables, RLS policies, migrations in `supabase/migrations/` |
| Auth | **Supabase Auth** | Email/password; `OWNER_EMAIL` gate on all sensitive API routes |
| Storage | Supabase (not used for large files) | — |
| Vector store | **Supabase pgvector** | `trade_memories` table; 1024-dim Jina/Voyage embeddings; cosine similarity |
| Server functions | **Next.js API routes** | All under `app/api/`; `force-dynamic` where needed |
| Cron (cloud) | **Vercel Crons** | Two crons in `vercel.json`; hit deployed URL |
| Cron (local) | **Windows Task Scheduler** | 8 tasks via `scripts/run-agents.ps1`; PC must be on |
| Observability | **Langfuse** | Traces `callLLM` (single-shot) + `runAgentLoop` (multi-step tool calls) |

---

## 3. AI / LLM

**Per-flow model selection (2026-07-12).** Every agent/flow's model is chosen from
**Settings → Agents → LLM Config** (`agent_config` table), NOT hardcoded. Routes read
`getConfiguredModel(svc, agentName, fallback)` (`lib/agent-model-config.ts`) and pass the
result to `callLLM({ model })`. `MODEL_ROUTING` in `lib/llm-router.ts` is now only the
DEFAULT when no model is passed. **Policy: default OFF Claude** — hard-reasoning flows
(research/trade/evaluate/thesis) default to `deepseek-v4-pro` with thinking explicitly
enabled; cheap flows use `deepseek-v4-flash` with thinking explicitly disabled. Claude is
opt-in per flow from Settings, never a silent default.

Providers (each key set in Settings → Provider API Keys, vault-first / env-fallback):

| Provider | Concrete models | Dispatch in llm-router |
|---|---|---|
| DeepSeek | `deepseek-v4-flash` (fast/non-thinking), `deepseek-v4-pro` (thinking) | `callDeepSeek` |
| Anthropic | `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8` | `callClaude` (extended thinking auto-on for research/trade/evaluate/thesis) |
| Groq | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, … | `callGroq` |
| Google | `gemini-2.5-flash`, `gemini-2.5-pro` | `callGemini` (added 2026-07-12) |
| xAI | `grok-4-fast`, `grok-4` | `callGrok` (added 2026-07-12) |

Tier aliases (`TIER_MODELS`): `fast`→`deepseek-v4-flash`, `reasoning`→`deepseek-v4-pro`,
`claude-fast`→Haiku, `claude-smart`→Sonnet. `LEGACY_ALIASES` transparently rewrites the
retiring `deepseek-chat`/`deepseek-reasoner` aliases to the concrete V4 IDs.
`SAME_TIER_FALLBACK` degrades a single unavailable model to a same-tier sibling (Gemini/Grok
fall back to `deepseek-v4-pro`) and raises a System Health alert. A missing Anthropic key
falls back to `deepseek-v4-flash`, not a crash. **No local Claude-CLI/PowerShell path exists
anymore** — `lib/claude-exec.ts` was deleted 2026-07-12; all LLM + data fetches are HTTP.

### Adding / changing models

To register a new model: call `registerLLMProvider()` in `lib/llm-router.ts` and update the
relevant tier alias. A System Health alert fires automatically when any model is
deprecated/renamed.

---

## 4. External brokers

| Broker | Market | Auth | Role |
|---|---|---|---|
| Robinhood | US | OAuth PKCE S256 loopback; token in `api_key_vault` | Read-only account (monitoring) + agentic account (orders only) |
| Zerodha Kite | India | Daily re-login; SHA256 checksum exchange; `KITE_ACCESS_TOKEN` in vault | Real NSE/BSE portfolio read + order placement |

### Broker adapter layer

**Location:** `lib/brokers/adapters/`, `lib/brokers/registry.ts`

All broker interactions go through a `BrokerAdapter` interface. Current adapters:

| Adapter | File | Market |
|---|---|---|
| `robinhood-mcp` | `lib/brokers/adapters/robinhood-mcp.ts` | US |
| `robinhood` | `lib/brokers/adapters/robinhood.ts` | US (direct REST, serverless-capable) |
| `kite` | `lib/brokers/adapters/kite.ts` | India |
| `alpaca` | `lib/brokers/adapters/alpaca.ts` | US (future) |
| `webull_trade` | `lib/brokers/webull-trade/` | US — **built, DISABLED, transport fixture-tested** |

The adapter registry (`lib/brokers/registry.ts`) resolves which adapter to use per market and
account role. The order placement code never calls a broker API directly — it goes through the
registry.

#### `webull_trade` — signed Webull Trading API (2026-07-18, disabled)

Webull exposes **two unrelated products** and they must never be combined:

| Surface | Registry | Role |
|---|---|---|
| Cloud MCP (`webull`) | `lib/brokers/mcp-registry.ts` | **Read-only.** Accounts/positions/balances/quotes. No order tools, no write scopes, `orderCapable:false`. Not in the order registry. |
| Trading API (`webull_trade`) | `lib/brokers/registry.ts` | **Signed REST money path.** The only Webull order surface. |

The inert MCP-based order scaffold (`lib/brokers/adapters/webull.ts`) was **deleted** along with
its `webull` order-registry entry — there is no second Webull order adapter.

**Module layout** (`lib/brokers/webull-trade/`):

| File | Purpose |
|---|---|
| `signing.ts` | HMAC-SHA1 request signing, implemented directly (no vendor SDK). One auditable canonical request; fresh nonce per request; timestamp-skew guard; constant-time verify. |
| `credentials.ts` | Vault-only app-key/app-secret/access-token accessor, provider tag `webull_trade`, bounded cache. **Sandbox and prod use separate env-prefixed vault keys bound to separate hosts derived from the same `env`, so a sandbox credential can never resolve a prod host.** |
| `gates.ts` | All 9 gates of the Mandatory Gate Ladder, pure and ordered. Every gate fails closed; unknown/undefined is never "satisfied". |
| `token.ts` | Token lifecycle `PENDING` / `NORMAL` / `INVALID` (15 idle days) / `EXPIRED` (5-min verify window). Fails closed on pending/invalid/expired/unknown/idle; alerts before the 15-day boundary; no keepalive traffic. |
| `preflight.ts` | Parses the official `POST /openapi/auth/token/check` response into the fresh server-confirmed token record required by gate 7. |
| `order.ts` | Normalization + boundary rejects. Scope locked to **market + limit + GTC `STOP_LOSS` in `CORE`**. `SHORT` is rejected even though the API accepts it — a capability is not a permission. Options, trailing, OCO/OTOCO, algos, extended/overnight sessions rejected. |
| `lifecycle.ts` | place/query/cancel/reconcile on a stable `client_order_id` (≤32). A timeout, a throw after send, or a 200 with no parseable order id → `needs_reconcile`: never success, never a blind resubmit. |
| `capabilities.ts` | `BrokerProtectiveCapabilities` declaration (shape per `features/hybrid-stop`; that shared type is not yet on `main`, so it is declared locally). Claims only US equity `sell_long` via GTC stop-market in the **regular** session. |
| `transport.ts` | Sole Webull `fetch` path. Adds signed headers plus `x-access-token`, pins host/env, wraps timeout/HTTP errors, and consumes one-shot capability permits. Preflight reads the database flag and cannot reach order endpoints; production order permits require all nine gates. |

**It places no order today** and fails closed on all three of: absent
`strategy_config.webull_trade_orders_enabled` (migration `20260718120000_...` written but
**NOT applied**), no allowlisted `broker_accounts{broker='webull_trade',market='us',role='trading'}`
row, and no `api_key_vault` `provider='webull_trade'` credential. Everything is verified against
fixtures with injected transports and fetch stubs only — no live or sandbox Webull call has been
made, and the registry adapter still refuses submit/query/cancel before constructing a transport.

**Before any live dollar** the owner must: confirm the Webull API entitlement; reconcile the
canonical signing layout, request paths, and hosts against the current official docs; provision the
vault records and the allowlist row; apply the migration; and run a manually-approved sandbox test.
Design + open decisions: `features/webull-trading-api/FEATURE_ARCHITECTURE.md`.

---

## 5. External data providers

| Provider | What it provides | Auth |
|---|---|---|
| Alpha Vantage (AV) | Technicals (RSI, EMA, MA), 8 macro indicators; **last-resort** fundamentals/insider fallback (25/day cap, usually exhausted) | `ALPHA_VANTAGE_API_KEY` in vault |
| Finnhub | **PRIMARY domestic-US fundamentals** — `/stock/metric` (P/E, net margin, ROE, EPS, revenue growth) + `/stock/profile2` (sector), mapped to AV-OVERVIEW shape in `lib/data/fundamentals.ts:fetchFinnhubOverview`. Metric cache is event-aware (1/7d); profile cache is 30d. Reviewed ADRs bypass Finnhub because it can resolve the foreign underlying. Free 60/min, no daily cap | `FINNHUB_API_KEY` in Vercel env |
| Massive Market Data | **FALLBACK US candles** (was primary; demoted 2026-07-22), stock screener, options, quotes; **PRIMARY US insider** — `/stocks/filings/vX/form-4` open-market P/S transaction scoring (`lib/data/massive-insider.ts`) | `MASSIVE_API_KEY` in vault |
| Yahoo Finance (fundamentals) | **SECONDARY domestic US + PRIMARY India + PRIMARY reviewed ADR fundamentals** — `quoteSummary` (crumb handshake) → AV-OVERVIEW shape via `fetchIndiaOverview` (market-agnostic: margin, ROE, revenue growth, P/E, sector). ADRs fail unavailable if Yahoo is thin; Kairos never mixes a foreign-underlying per-share response with a USD ADS price. Unofficial — cached, paced + fail-soft | None (crumb) |
| SEC EDGAR (fundamentals) | **NOT WIRED** — `lib/data/sec-fundamentals.ts` companyfacts adapter is experimental; a 2026-07-13 spot-check found its raw-tag margin/ROE unreliable (needs the `frames` API). Left for a future task | None |
| FMP | `screen_stocks` screener for US momentum/value buckets; **secondary** fundamentals fallback only (its `/stable/ratios-ttm`+`/key-metrics-ttm` are premium-gated on the free plan → usually returns nothing, so Finnhub is primary) | `FMP_API_KEY` in vault |
| FinancialDatasets | Supplemental US screener discovery and manual Scanner fundamentals — **metered credits; currently $0 balance**. Entitlement/HTTP/timeout failures report a self-healing System Health warning and fall back to non-FD candidate queues; this provider is NOT used for ResearchAgent scoring fundamentals (Finnhub/Yahoo own that path; SEC remains experimental and unwired). | `FINANCIAL_DATASETS_API_KEY` in vault |
| Jina AI | `jina-embeddings-v3` embeddings (1024-dim, free) + `jina-reranker-v2-base-multilingual` reranker (free, 1M tokens/month, no CC) | `JINA_API_KEY` in `.env.local` |
| Langfuse | LLM trace/generation observability | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` |
| Resend | Transactional email (briefings) | `RESEND_API_KEY` |
| Stripe | Subscription billing (Pro/Elite tiers) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` |
| Yahoo Finance | **PRIMARY US candles** — `v8/finance/chart/{SYMBOL}?interval=1d&range=1y` (no key, no observed rate limit, 251 adjusted bars, works for US+India); also India `.NS` price+candles (free, no auth) + fundamentals (cookie+crumb). Recency-guarded in `fetchUsCandles`: stale source (newest bar > 4 calendar days old) is rejected before fallback chain runs. | None |
| NSE public JSON | Full equity list (`EQUITY_L.csv`), insider trades (`corporates-pit`), option chain, **daily FII/DII net cash flows** (`fiidiiTradeReact`, `lib/india-macro.ts` — India macro input, verified reachable from Vercel 2026-07-12) | Cookie handshake via `lib/nse-data.ts` / `lib/india-macro.ts` |
| GDELT DOC 2.0 | US fallback/theme discovery only. The India per-symbol scoring dependency was retired 2026-07-31 after 0/310 usable production observations and traffic-policy throttling. | None (public API) |
| NSE announcements + Google News RSS | India replacement **shadow**: official company announcements plus bounded unofficial headline coverage. Stored in canonical evidence cache; no scorer or money-path reader. | None |
| ~~House Stock Watcher~~ | **DEAD — REMOVED 2026-07-16.** Was congressional stock trade disclosures. Bucket taken private: `us-east-2` → HTTP 301 PermanentRedirect, `us-west-2` → HTTP 403 AccessDenied; project unmaintained (sibling Senate Stock Watcher is 403 too). `/api/markets/insider-trades` no longer fetches — it returns an explicit `discontinued` state + a System Health alert (`markets-congress-source:discontinued`), and the Markets panel renders a permanent "Discontinued" note with no retry. **No free replacement qualified:** Lambda Finance (`lambdafin.com/api/congressional/recent`) serves live data on HTTP 200 but its ToS forbid automated access ("any data mining, robots, or similar data gathering and extraction tools"; "personal, non-commercial use ... only") and it re-serves FMP data; Finnhub/FMP gate it behind a paid tier (violates free-cloud-only); the official House clerk feed publishes filing **metadata only** (no ticker/amount/side — trades are per-filing scanned PDFs needing OCR, explicitly out of scope). Restore only if a licence-clean free source appears. | — (retired) |
| SEC EDGAR | Form 4 CIK lookup + XML → `evidence_records` | None (public) |
| StockTwits | Social sentiment for US tickers | (check vault) |
| WandB | Experiment tracking (optional) | `WANDB_API_KEY` in `.env.local` |
| Robinhood MCP | JSON-RPC tool bridge for Robinhood agentic account | OAuth token in vault |

---

## 6. Provider adapter layer (added 2026-07-10)

Swap providers by changing one env var. Each adapter implements a shared interface;
callers never know which concrete provider runs.

### Embedding provider

**Env var:** `EMBEDDING_PROVIDER=jina|openai`
**Location:** `lib/providers/embeddings/`

| Value | Provider | Model | Notes |
|---|---|---|---|
| `jina` (default) | Jina AI | `jina-embeddings-v3` (1024-dim) | Free 1M tokens/month; no CC required |
| `openai` | OpenAI | `text-embedding-3-small` (1536-dim) | Requires `OPENAI_API_KEY` |

### Rerank provider

**Env var:** `RERANK_PROVIDER=jina|cohere`
**Location:** `lib/providers/rerank/`

| Value | Provider | Model | Notes |
|---|---|---|---|
| `jina` (default) | Jina AI | `jina-reranker-v2-base-multilingual` | Free 1M tokens/month |
| `cohere` | Cohere | `rerank-english-v3.0` | Requires `COHERE_API_KEY` |

### Email provider

**Env var:** `EMAIL_PROVIDER=resend|smtp`
**Location:** `lib/providers/email/`

| Value | Provider | Notes |
|---|---|---|
| `resend` (default) | Resend | Requires `RESEND_API_KEY`; test-mode sends to `BRIEFING_TO` |
| `smtp` | Any SMTP server | Requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` |

---

## 7. Key library files

| File | Purpose |
|---|---|
| `lib/llm-router.ts` | LLM tier resolution, `callLLM()`, `runAgentLoop()`, Langfuse tracing |
| `lib/vault.ts` | Read/write runtime keys from `api_key_vault` table |
| `lib/av-cache.ts` | Alpha Vantage day-cache + daily budget guard |
| `lib/research-agent.ts` | Core scoring pipeline (deterministic, no LLM) |
| `lib/brokers/registry.ts` | Broker adapter registry |
| `lib/market-context.tsx` | `MarketProvider` / `useMarket()` hook |
| `lib/market-support.ts` | Coverage level map per route |
| `lib/india-data.ts` | Yahoo Finance + NSE data adapters |
| `lib/nse-data.ts` | NSE cookie-handshake adapter |
| `lib/system-health.ts` | `reportIssue()` / `resolveIssue()` helpers |
| `lib/autonomy.ts` | Autonomy ladder check; `AUTONOMOUS_LIVE_ENABLED = false` (constant) |
| `lib/validators/backtest.ts` | Validation Engine (deterministic replay) |
| `lib/evaluation/run-evaluation.ts` | Performance Truth Layer evaluation runner |
| `lib/robinhood-mcp-client.ts` | Robinhood MCP JSON-RPC client + token refresh CAS |
