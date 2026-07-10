# Kairos — Tech Stack
> Last updated: 2026-07-10
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

| Model alias | Concrete model | Primary use |
|---|---|---|
| `fast` | Groq `llama-3.3-70b-versatile` | Research thesis + direction (512 tokens, sub-second) |
| `reasoning` | DeepSeek `deepseek-reasoner` | LearnerAgent challenger proposals (legacy; superseded by Opus) |
| `claude-fast` | Claude Haiku 4.5 | Triage agent, briefing editor's note |
| `claude-smart` | Claude Sonnet 4.6 | Mentor coaching notes, complex analysis |
| `claude-opus` | Claude Opus 4.8 | LearnerAgent brain (upgraded 2026-07-03) |
| DeepSeek agent | `deepseek-chat` | Parallel screener run for P&L comparison |

LLM routing lives in `lib/llm-router.ts`. Tier aliases avoid hardcoded model names per
agent — a deprecated model triggers a System Health alert and auto-resolves when reassigned.
`SAME_TIER_FALLBACK` ensures a single unavailable model degrades gracefully rather than
breaking the whole agent.

### LLM tier → agent assignment

| Agent | Tier used | Why |
|---|---|---|
| ResearchAgent thesis | `fast` (Groq) | 512 tokens, sub-second; scores are deterministic |
| LearnerAgent brain | `claude-opus` | Best reasoning for weight proposals |
| MentorAgent | `claude-smart` | Quality coaching notes |
| Health-Triage | `claude-fast` | Cheap, frequent |
| Briefing editor note | `claude-fast` | Cheap |
| DeepSeekAgent | `deepseek-chat` | Explicit P&L comparison |

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
| `kite` | `lib/brokers/adapters/kite.ts` | India |
| `alpaca` | `lib/brokers/adapters/alpaca.ts` | US (future) |

The adapter registry (`lib/brokers/registry.ts`) resolves which adapter to use per market and
account role. The order placement code never calls a broker API directly — it goes through the
registry.

---

## 5. External data providers

| Provider | What it provides | Auth |
|---|---|---|
| Alpha Vantage (AV) | Technicals (RSI, EMA, MA), OVERVIEW fundamentals, NEWS_SENTIMENT, INSIDER_TRANSACTIONS, 8 macro indicators | `ALPHA_VANTAGE_API_KEY` in vault |
| Massive Market Data | US candles, stock screener, options, quotes | `MASSIVE_API_KEY` in vault |
| FinancialDatasets (FMP) | `screen_stocks` screener for US momentum/value buckets | `FMP_API_KEY` in vault |
| Jina AI | `jina-embeddings-v3` embeddings (1024-dim, free) + `jina-reranker-v2-base-multilingual` reranker (free, 1M tokens/month, no CC) | `JINA_API_KEY` in `.env.local` |
| Langfuse | LLM trace/generation observability | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` |
| Resend | Transactional email (briefings) | `RESEND_API_KEY` |
| Stripe | Subscription billing (Pro/Elite tiers) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` |
| Yahoo Finance | India `.NS` price+candles (free, no auth) + fundamentals (cookie+crumb) | None |
| NSE public JSON | Full equity list (`EQUITY_L.csv`), insider trades (`corporates-pit`), option chain | Cookie handshake via `lib/nse-data.ts` |
| House Stock Watcher | Congressional stock trade disclosures | None (public S3) |
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
