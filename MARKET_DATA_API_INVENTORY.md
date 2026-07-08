# Market Data / API Inventory and Cheapest Daily Coverage Plan — 2026-07-07

Purpose: map every external data/API source Kairos currently uses, which agent/flow consumes it, which signal dimension it supports, what tier/cost is known, and what the cheapest reliable setup should be for both the US and India pipelines.

This is an inventory/review document. No production code was changed.

## Executive summary

Kairos is not “just Alpha Vantage.” The current app uses:

- US data: Alpha Vantage, Massive/Polygon-compatible API, FinancialDatasets, StockTwits, Yahoo options, SEC EDGAR, House Stock Watcher, Robinhood MCP, Alpaca stubs.
- India data: Yahoo Finance chart/quoteSummary, NSE public/undocumented JSON/CSV feeds, Zerodha Kite, plus app-side cached NSE screen data.
- AI/agent services: DeepSeek, Groq, Voyage embeddings, Resend email, Langfuse optional tracing.

The core bottleneck is Alpha Vantage. The app correctly added `av_cache` and `av_budget`, but Alpha Vantage free is still only 25 requests/day. A single fresh US equity research pass can spend roughly:

| Per new US symbol | Source | Approx calls |
|---|---|---:|
| Fundamentals | Alpha Vantage `OVERVIEW` | 1 |
| Daily candles for local RSI/EMA | Alpha Vantage `TIME_SERIES_DAILY_ADJUSTED` | 1 |
| Sentiment/news | Alpha Vantage `NEWS_SENTIMENT` + StockTwits | 1 AV + 1 StockTwits |
| Insider | Alpha Vantage `INSIDER_TRANSACTIONS` | 1 |
| Optional options | Yahoo options | 1 |

That means 5 fresh US symbols can consume ~20 AV calls before MacroSentinel, ThemeScout, earnings, corporate actions, Smart Money pages, and user-driven chart/detail pages. The budget cache prevents runaway use, but it also means missing/stale dimensions are expected on free AV if the daily universe is larger than a handful of new symbols.

Bottom line recommendation:

1. Keep free sources where they are genuinely good: SEC EDGAR, House Stock Watcher, Yahoo India, NSE feeds, Resend free, StockTwits as best-effort only.
2. Make Massive the primary US price/history/technical source. If the current Massive key is Free, upgrade to Stocks Starter ($29/mo) if agent/page load volume crosses 5 calls/minute or if intraday reliability matters.
3. Do not rely on Alpha Vantage free for all per-symbol dimensions. Either:
   - keep AV free and cap research to ~3–5 fresh US symbols/day with stale-cache fallback, or
   - upgrade AV to the cheapest premium plan ($49.99/mo, no daily limits) if you want daily fresh fundamentals/news/insider/options-style AV coverage across 10+ symbols.
4. Use FinancialDatasets only for screening/fundamental snapshots where it adds value. The current key is configured in the vault; public pricing is credits ($20 one-time for 1,000 requests) or Build ($200/mo for 100,000 requests). The $20 credits path is the cheapest controlled option.
5. India can remain mostly free using Yahoo + NSE, but it is brittle. If live India execution becomes serious, Zerodha Kite paid Connect (₹500/month) is the cheapest official way to get Kite historical/live market data; Personal free has order/portfolio but no live market data or historical candles.

## Configured providers found in this repo/session

Source of truth checked:

- `.env.local` key names only, no secret values read into this document.
- `api_key_vault` key names only, no secret values read into this document.
- Repo scan across `app/`, `lib/`, `supabase/functions/`, and `scripts/`.

| Provider | Configured? | Where found | Current known tier |
|---|---:|---|---|
| Alpha Vantage | Yes | `.env.local`, `api_key_vault` | Assume Free unless billing says otherwise. Repo default `AV_DAILY_BUDGET=25`. Official free limit is 25 requests/day; premium starts $49.99/mo with no daily limits. |
| Massive / Polygon-compatible | Yes | `.env.local`, `api_key_vault` | Tier cannot be inferred from key. Official pricing page/search snippet shows Stocks Basic Free: 5 calls/min, 2 years historical; Stocks Starter: $29/mo, unlimited aggregates. |
| FinancialDatasets | Yes | `api_key_vault` | Tier cannot be inferred. Official pricing: $20 one-time credits for 1,000 requests; Build $200/mo for 100,000 requests. |
| StockTwits | No key used | Public REST URL | Best-effort/unofficial-ish for this app; official docs now say to contact enterprise support for full queries. Treat as opportunistic only. |
| Yahoo Finance | No key | Public chart/options/quoteSummary endpoints | Free/unofficial. No SLA. Used heavily for India and US options fallback. |
| NSE India public feeds | No key | `www.nseindia.com`, archives CSV | Free/undocumented. Fails soft. Good for India universe/events/options/PIT disclosures, but reliability risk. |
| SEC EDGAR | No key | `sec.gov`, `data.sec.gov` | Free official. Must use declared User-Agent and stay under fair access limits. |
| House Stock Watcher S3 | No key | Public S3 JSON | Free public dataset. Reliability depends on third-party dataset maintenance. |
| Zerodha Kite | Yes | `api_key_vault` | Kite Personal/free likely: order, GTT, alerts, portfolio/margins; no live market data/historical candles. Paid Connect ₹500/mo adds live WebSocket + historical candles. |
| Robinhood MCP | Yes | `api_key_vault`, `knowledge/CONNECTIONS.md` | Broker/account/quotes/order execution for US Robinhood-supported assets. No public sandbox. Agentic account only. |
| Alpaca | Not configured in env/vault from this scan | Code stubs in `lib/brokers` | Optional broker path; not part of current daily data pipeline. |
| DeepSeek | Yes | `.env.local`, `api_key_vault` | Paid/usage-based model API; used for reasoning/synthesis/mentor/deep dive. |
| Groq | Yes | `.env.local`, `api_key_vault` | Used as cheap/free-ish LLM path for screening/theme tasks. Public free tiers can change; monitor model availability. |
| Voyage AI | Yes | `.env.local` | Embeddings for live portfolio/decision semantic search. Current model `voyage-finance-2`, 1024-dim. |
| Resend | Yes | `api_key_vault` | Free plan: 3,000 emails/month and 100/day; enough for one-user briefings/alerts. |
| FRED/ALFRED | Not implemented in code | Knowledge/architecture docs only | Recommended replacement for AV macro. FRED requires free API key; official docs mention rate limiting and 429s. |

## US pipeline by agent/flow

### ResearchAgent / `/api/agents/research/cron?market=us`

| Dimension | Current source(s) | Code path | Cost/limit risk | Current behavior | Recommendation |
|---|---|---|---|---|---|
| Candidate universe | Watchlist + live holdings + FinancialDatasets screener + theme scout additions | `lib/research-agent.ts`, `app/api/agents/research/scan/route.ts` | FinancialDatasets requests can become paid/credit-limited. | Screener tries FD if key exists; fallback to watchlist/signals. | Use FD only for broad candidate generation, cache results daily, and keep candidate cap. |
| Fundamentals | Alpha Vantage `OVERVIEW`; FD snapshot in scanner; FD screener | `lib/research-agent.ts: fetchAVOverview`, `app/api/agents/research/scan/route.ts` | AV free cannot fresh-cover many symbols/day. FD credits are limited. | Day-cached via `avCachedFetch`. Missing fields reduce/renormalize evidence. | Prefer FD snapshot for fundamentals if using credits; otherwise AV premium if >5 fresh symbols/day. |
| Technicals | Alpha Vantage `TIME_SERIES_DAILY_ADJUSTED`, local RSI/EMA; separate scanner uses AV `RSI`, `EMA`, `GLOBAL_QUOTE` | `lib/research-agent.ts`, `lib/data/technicals.ts`, `app/api/agents/research/scan/route.ts` | AV call-heavy. | Day-cached; local deterministic computation. | Move US candles/technicals to Massive aggregates where possible; reserve AV for data that Massive does not cover. |
| Sentiment/news | StockTwits public stream + Alpha Vantage `NEWS_SENTIMENT` | `lib/social-sentiment.ts` | StockTwits availability/rules uncertain; AV per-symbol calls expensive. | Best-effort; unavailable dimensions excluded from weighted score. | Treat sentiment as optional, not gate-critical. For reliability, replace with a paid news source later or FD news credits. |
| Insider | Alpha Vantage `INSIDER_TRANSACTIONS`; separate SEC EDGAR Form 4 route exists | `lib/research-agent.ts`, `app/api/markets/edgar-insiders/route.ts` | AV per-symbol insider calls expensive; EDGAR free but parser route is UI/on-demand. | Research uses AV insider; EDGAR route stores notable buys separately. | Use SEC EDGAR as primary for Form 4/insider; use AV insider only as fallback/cache. |
| Options | Yahoo options endpoint | `lib/options-signal.ts` | Free/unofficial, can fail. | Skipped for ETFs/India; optional. | Keep as advisory only. If options becomes core, use Massive options plan or broker-supported options data. |
| Macro/regime | DB `macro_regime`/`macro_signals`; MacroSentinel populated from AV economic endpoints | `lib/data/scores.ts`, `app/api/agents/macro-sentinel/route.ts` | AV weekly macro burns ~8 calls/run. | Weekly, insufficient-data guard exists. | Replace with FRED/ALFRED; it is the right free official macro source and avoids AV budget contention. |
| Thesis/narrative | DeepSeek/Groq via `llm-router` | `lib/llm-router.ts`, `lib/research-agent.ts` | Model cost/rate limits. | LLM does not invent prices/scores; writes thesis/direction. | Keep. Add data-source coverage summary into prompt so missing dimensions are explicit. |

### ThemeScout

| Input | Current source | Code path | Cost/limit risk | Recommendation |
|---|---|---|---|---|
| Market news/themes | Alpha Vantage `NEWS_SENTIMENT`; AV `TOP_GAINERS_LOSERS`; Groq LLM | `app/api/agents/theme-scout/route.ts` | 2 AV calls/run plus `OVERVIEW` checks for each proposed ticker. | Keep weekly/daily-low-frequency only. Do not run inside every research pass unless budget is available. Consider using Massive movers for price movers and AV only for theme/news. |
| Ticker existence validation | Alpha Vantage `OVERVIEW` | `app/api/agents/theme-scout/route.ts` | Candidate validation can consume several AV calls. | Replace existence validation with Massive reference tickers or FinancialDatasets ticker reference to avoid AV burn. |

### MacroSentinel

| Indicator group | Current source | Calls | Issue | Recommendation |
|---|---|---:|---|---|
| Treasury yields, unemployment, payroll, GDP, CPI, retail sales, fed funds, durables | Alpha Vantage economic functions | ~8/week | Uses scarce AV quota for data FRED provides officially. | Move to FRED/ALFRED with vintage support. Keep AV macro only as fallback. |

### PaperTrader

| Need | Current source | Code path | Risk | Recommendation |
|---|---|---|---|---|
| US fill/current price | `getQuote()` / `getBatchQuotes()` — Massive snapshot first for batch, AV quote fallback, `price_cache` fallback | `app/api/agents/paper-trade/route.ts`, `lib/data/quotes.ts` | Good for batch if Massive tier supports volume; AV fallback can burn quota. | Keep Massive primary. Avoid per-symbol AV fallback during daily portfolio refresh unless no Massive key. |
| US benchmark SPY alpha | Alpha Vantage quote via `getQuote("SPY")` fallback path | `app/api/agents/paper-trade/route.ts` | Can consume 1 AV/day if Massive not used there. | Route SPY benchmark through Massive batch too. |

### PositionMonitor

| Need | Current source | Code path | Risk | Recommendation |
|---|---|---|---|---|
| US open position prices | Massive prev-day bar | `app/api/agents/position-monitor/route.ts` | Uses previous bar, not truly live. | For swing trading EOD monitor this is acceptable. For intraday stop logic, use broker quotes or Massive Starter. |

### Briefing / Markets / Dashboard pages

| Page/flow | Current source(s) | Risk | Recommendation |
|---|---|---|---|
| Markets overview | Massive prev-day bars for SPY/QQQ/DIA/VIXY/sector ETFs | Free Massive 5/min can be enough if cached; page refreshes may spike. | Add app-level cache/revalidate on all page endpoints. Massive Starter if interactive use grows. |
| Market synthesis | Massive quotes + DeepSeek | LLM cost and Massive calls. | Cache synthesis aggressively; already does some caching. |
| Earnings calendar | Alpha Vantage `EARNINGS_CALENDAR` | One broad call can be okay, but still AV budget. | Keep 1/day cache; avoid per-symbol earnings calls in TraderAgent. |
| Smart Money | Alpha Vantage insider + House Stock Watcher | AV per-symbol burn. | Prefer EDGAR for insider, House dataset for Congress. |
| Live portfolio enrich/performance | Alpha Vantage daily adjusted; Massive daily series | Can be heavy on first run. | Use Massive for series; avoid AV full-series except backfill/manual enrich. |

## India pipeline by agent/flow

### ResearchAgent / `/api/agents/research/cron?market=india`

| Dimension | Current source(s) | Code path | Cost/limit risk | Current behavior | Recommendation |
|---|---|---|---|---|---|
| Candidate universe | `india_screen_cache` from nightly NSE/Yahoo scan + watchlist + Kite holdings | `lib/research-agent.ts`, `app/api/scan/india/refresh/route.ts` | Free but Yahoo/NSE unreliable. | Full NSE list from NSE CSV if available, fallback to NIFTY universe. | Keep cache-first. Add data-age UI and skip stale cache older than N days. |
| Fundamentals | Yahoo Finance `quoteSummary` mapped to AV-like overview | `lib/india-data.ts: fetchIndiaOverview` | Unofficial, can throttle/change shape. | Missing fields reduce evidence. | Accept for free tier. For better reliability, evaluate paid FinancialDatasets India coverage or official exchange/vendor later. |
| Technicals | Yahoo chart candles; local RSI/EMA | `lib/india-data.ts`, `lib/data/technicals.ts` | Free/unofficial, but adequate for swing EOD if cached. | Nightly cache refresh rotates ~600 symbols/run. | Keep. If India becomes real-money active, consider Kite Connect paid ₹500/mo for official historical candles/live data. |
| Quote/fill/current price | Yahoo chart `regularMarketPrice` | `fetchIndiaQuote()` | Free/unofficial; not broker-executable quote. | Used by PaperTrader and panels. | For live India orders, use Kite quote/historical data if paid; for paper, Yahoo is acceptable. |
| Insider/PIT disclosures | NSE `corporates-pit` | `lib/nse-data.ts`, `app/api/india/insider/route.ts` | Free/undocumented; can block non-India IPs. | Fails soft. | Keep as advisory. Cache and show “NSE unavailable” honestly. |
| Earnings/events | NSE event calendar, Yahoo per-symbol fallback | `lib/nse-data.ts`, `app/api/calendar/earnings-india/route.ts` | NSE free/undocumented, Yahoo per-symbol slow. | Fails soft to Yahoo. | Keep; cache daily. |
| Options flow | NSE option-chain | `lib/nse-data.ts`, `app/api/india/options/route.ts` | Free/undocumented. | PCR/top OI strikes, not true options flow. | Keep advisory; label as OI/chain, not flow. |
| Broker portfolio/execution | Zerodha Kite | `lib/kite.ts`, `/api/kite/*`, broker adapter | Personal/free has order/portfolio but no live market data/historical. Paid Connect ₹500/mo adds data. | Daily token required. | For serious live India execution, use paid Kite Connect data or keep live execution manual and paper pricing from Yahoo. |

### India scanner

| Mode | Source | Coverage | Risk | Recommendation |
|---|---|---|---|---|
| Cache mode | `india_screen_cache` prefilled by NSE equity list + Yahoo fundamentals/candles | Whole NSE over several nights | Good coverage, free, brittle feed. | Best cheap path. Add provider-health alert if cache oldest row > 5 trading days. |
| Live fallback | NIFTY/NSE curated universe + Yahoo | ~NIFTY-100 | Slow but acceptable. | Keep as fallback only. |

## Current cache/budget design

| Mechanism | Tables/functions | What it does well | Gap |
|---|---|---|---|
| Alpha Vantage response cache | `av_cache` | One payload per `cache_key` per day; fallback to last-known data. | It is AV-specific by name but is reused for FinancialDatasets snapshots (`FD_SNAPSHOT:*`). |
| Alpha Vantage budget counter | `av_budget`, `av_budget_increment` | Hard cap default 25/day; fail-closed if counter errors. | `avCachedFetch` increments this counter even for non-AV URLs when reused, so FD calls can consume AV budget slots incorrectly. |
| Price cache | `price_cache` | EOD fallback for quotes/candles. | Needs consistent refresh/source freshness by market. |
| India screen cache | `india_screen_cache` | Makes broad India scanning feasible on free data. | Needs staleness dashboard and provider health alerts. |

Fix recommendation: replace `avCachedFetch()` with a generic `providerCachedFetch(provider, cacheKey, url, budgetKey, dailyBudget)` or create separate wrappers:

- `avCachedFetch()` for Alpha Vantage only.
- `fdCachedFetch()` with its own budget counter/credits.
- `genericDailyCachedFetch()` for no-budget public sources.

## Cheapest viable plan by operating mode

### Mode A — Lowest cash cost / free-first

Use if you want paper trading + research on a small universe and are okay with stale/missing dimensions.

| Provider | Tier |
|---|---|
| Alpha Vantage | Free, 25/day, strict cache |
| Massive | Free if current usage stays under 5 calls/min |
| FinancialDatasets | Use existing key/credits sparingly, or no key |
| Yahoo Finance | Free/unofficial |
| NSE | Free/undocumented |
| SEC EDGAR | Free official |
| House Stock Watcher | Free public |
| StockTwits | Best-effort |
| Zerodha Kite | Personal/free for order/portfolio only |
| Resend | Free |

Daily cap under this mode:

- US: 3–5 fresh researched symbols/day max if you want fundamentals + technical + sentiment + insider fresh.
- India: broader scan is possible because Yahoo/NSE are free, but reliability is weaker and should be cache-first.

### Mode B — Cheapest setup I would trust for daily US + India agent operation

Use if you want the agents to run daily without obvious data starvation.

| Provider | Tier | Why |
|---|---|---|
| Massive Stocks Starter | $29/mo | Make US prices/history/sector/index/portfolio refresh reliable and avoid AV quote/candle burn. |
| Alpha Vantage Free or Premium | Free if AV-only dimensions are capped; $49.99/mo if researching 10+ fresh US names/day | AV remains useful for news sentiment, insider, earnings, corporate actions, options endpoint. Free is not enough for broad fresh coverage. |
| FinancialDatasets Credits | $20 one-time / 1,000 requests | Cheap way to support occasional broad fundamentals/screening without committing to $200/mo Build. |
| Zerodha Kite Connect paid data | ₹500/mo only if live India execution/data accuracy matters | Gives official Kite live/historical data. Keep Personal/free if India is paper/advisory only. |
| Resend Free | $0 | One-user briefings are well under 100/day. |
| SEC/FRED/NSE/Yahoo/House | Free | Use with caching and clear staleness labels. |

Expected monthly floor: $29/mo if you can keep AV under free cap. More realistic robust floor for US daily breadth: $29 + $49.99 = ~$79/mo, plus optional ₹500/mo for official India market data and $20 FD credits as needed.

### Mode C — Best long-term architecture without expensive enterprise feeds

1. Massive = US price/history/technical aggregates.
2. SEC EDGAR = filings/Form 4 primary.
3. FRED/ALFRED = macro primary, with vintages to avoid look-ahead bias.
4. FinancialDatasets credits = US fundamentals/screener/news only when needed.
5. Alpha Vantage = fallback/secondary for sentiment, earnings calendar, corporate actions/options until replaced.
6. Yahoo/NSE = India free pipeline, cache-first.
7. Kite paid data = only if India live trading becomes more than manual/advisory.

## What looks missing or weak today

| Gap | Why it matters | Fix |
|---|---|---|
| FRED/ALFRED not implemented | MacroSentinel spends AV calls on macro data and lacks vintage history. | Add FRED key + macro adapter; keep AV macro fallback. |
| AV budget shared with non-AV cache calls | FinancialDatasets snapshot calls can consume AV budget slots if routed through `avCachedFetch`. | Split provider cache/budgets. |
| Some legacy Supabase Edge Functions still call AV directly | `supabase/functions/research-agent`, `deepseek-research`, `position-monitor`, `newsletter-daily`, etc. bypass Next.js cache/budget logic if still deployed/invoked. | Confirm active cron uses Next.js routes only; decommission or update Edge Functions to use the same provider cache semantics. |
| ThemeScout existence validation burns AV `OVERVIEW` calls | A theme run can spend several scarce AV calls before research starts. | Validate tickers via Massive reference endpoint or FD ticker/reference endpoint. |
| US scanner uses AV RSI/EMA/GLOBAL_QUOTE | This is call-heavy and redundant with Massive. | Use Massive aggregate candles and compute RSI/EMA locally. |
| Research uses AV insider instead of SEC primary | AV insider is paid/quota-limited; SEC is official/free. | Promote SEC Form 4 adapter into the ResearchAgent scoring path. |
| StockTwits source reliability unclear | Official access appears enterprise-oriented; unauthenticated endpoints may break. | Treat sentiment as optional; do not let missing sentiment block a trade or fabricate neutral evidence. |
| India Yahoo/NSE feeds are free but unofficial | Feed shape/anti-bot behavior can change. | Cache-first, provider-health alerts, fallback universes, and “data stale/unavailable” UI labels. |
| Kite Personal has no market data | Live India order execution should not rely on Yahoo quotes forever. | For live India trading, either pay ₹500/mo for Kite Connect data or keep India live trading manual/disabled. |
| Provider tier not visible in app | User cannot tell if a missing dimension is quota, key, provider outage, or intentionally skipped. | Add Settings/Admin “Data Providers” dashboard: key present, tier assumption, daily calls used, cache hit rate, stale dimensions by agent. |

## Per-dimension target source map

| Dimension | US target | India target | Notes |
|---|---|---|---|
| Tradable universe | Robinhood MCP + Massive/FD reference + watchlist | NSE equity CSV + Kite holdings + watchlist | Must be deterministic; no LLM ticker invention. |
| Price/quote | Massive primary; Robinhood quote at execution | Yahoo for paper; Kite paid data for live | Broker quote should win at live execution time. |
| Candles/history | Massive aggregates | Yahoo free or Kite paid historical | Compute RSI/EMA locally. |
| Fundamentals | FD credits or AV `OVERVIEW` | Yahoo quoteSummary | Missing fundamentals should exclude/renormalize. |
| Sentiment/news | AV news or FD news; StockTwits optional | Not reliable/free today | Treat as optional weak signal. |
| Insider | SEC EDGAR Form 4 primary | NSE PIT disclosures | AV insider fallback only. |
| Earnings | AV calendar / FD earnings | NSE event calendar + Yahoo per-symbol fallback | Cache daily. |
| Dividends/splits | AV corporate actions for now | NSE/BSE/Yahoo/Kite if available | Important for ex-dividend/tax planning; needs dedicated cache. |
| Macro | FRED/ALFRED primary | FRED/global + India macro source TBD | AV macro should be fallback. |
| Options | Yahoo options advisory or Massive options paid | NSE option chain OI/PCR | Label OI as OI, not true flow. |
| Broker/account state | Robinhood MCP | Kite | Never via LLM. |

## Suggested daily call budget

### US daily, free-first

| Flow | Provider budget |
|---|---|
| Research 3 fresh symbols | AV: ~12 calls; StockTwits: 3; Massive: small; LLM: 3 |
| ThemeScout | AV: 2 + candidate validation calls. Run only if AV budget > 8 remaining. |
| Earnings calendar | AV: 1 cached/day |
| Corporate actions | AV: run only for held/watchlist subset; not daily for every symbol |
| MacroSentinel | Move to weekly and preferably FRED; if AV, ~8 calls/week |
| Pages/briefing | Massive cached; avoid AV on page load |

### US daily, robust cheap paid

| Flow | Provider budget |
|---|---|
| Research 10–20 fresh symbols | Massive for candles/quotes; FD/AV for fundamentals/news/insider; AV premium or FD credits required |
| ThemeScout | Massive movers + Groq; AV news once/day max |
| Macro | FRED |
| Pages | Massive Starter cache |

### India daily

| Flow | Provider budget |
|---|---|
| Nightly NSE refresh | NSE equity CSV once/day; Yahoo quoteSummary/chart up to 600 symbols/run in batches |
| Research | Reads cache + Yahoo for selected symbols + Kite holdings |
| PaperTrader / PositionMonitor | Yahoo quote per open position |
| Earnings/options/insider panels | NSE APIs cached daily/intraday |
| Live trading | Kite order/portfolio; use Kite paid data if requiring official market data |

## Source references checked

- Alpha Vantage premium page: free endpoints exist, standard free limit is 25 requests/day; premium starts at $49.99/mo and removes daily limits: https://www.alphavantage.co/premium/
- Massive pricing search result: Stocks Basic Free is 5 calls/min with 2 years historical; Stocks Starter is $29/mo with unlimited aggregates: https://massive.com/pricing
- FinancialDatasets pricing: Credits $20 one-time for 1,000 requests; Build $200/mo for 100,000 requests: https://www.financialdatasets.ai/pricing
- Zerodha Kite Connect FAQ: Personal free includes order/GTT/alerts/margin/portfolio but no live market data or historical; paid Connect is ₹500/month and adds live WebSockets + historical candles; no sandbox; static IP required for orders from April 1, 2025: https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/kite-connect-api-faqs
- SEC EDGAR access: free access, declared User-Agent, current max request rate 10 requests/second: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
- FRED API docs: requires API key and returns 429 when rate-limited: https://fred.stlouisfed.org/docs/api/fred/errors.html and https://fred.stlouisfed.org/docs/api/api_key.html
- Resend pricing: Free is 3,000 emails/month and 100/day; Pro starts $20/mo: https://resend.com/docs/knowledge-base/what-is-resend-pricing
- StockTwits API docs currently point queries toward enterprise support: https://api-docs.stocktwits.com/

## Claude fix prompt

Use this if handing off implementation:

> Read `MARKET_DATA_API_INVENTORY.md`. Implement only the provider-budget fixes, not a full redesign. First, split `avCachedFetch` into provider-specific cache/budget wrappers so FinancialDatasets calls no longer increment `av_budget`. Second, route US scanner technicals and ThemeScout ticker validation away from Alpha Vantage where Massive/FD can satisfy the same need. Third, add a Settings/Admin Data Providers panel showing key presence, assumed tier, daily call count, cache hit/stale fallback count, and per-agent missing dimensions for US and India. Fourth, draft but do not enable a FRED/ALFRED macro adapter to replace Alpha Vantage macro calls. Do not change trading execution behavior.

## Addendum — cheaper/better alternatives to evaluate

The current stack is workable, but it is not necessarily the cheapest “good enough” stack. The best cheap architecture is to avoid forcing one provider to do everything. Use each source where it is strongest.

| Provider | Current public price signal checked | Strength | Weakness | Fit for Kairos |
|---|---:|---|---|---|
| Tiingo | Starter $0, Power $30/mo; free API shows 500 unique symbols/month, 50 req/hour, 1,000 req/day; Power shows 10,000 req/hour, 100,000 req/day. Fundamentals are listed as add-on/contact. | Clean EOD data, large global/security coverage, generous request limits for price history. | Fundamentals/news may require add-on/contact; not a one-stop replacement unless add-on pricing works. | Strong candidate to replace/backup Massive for EOD history and maybe news if add-on is acceptable. |
| EODHD | Free 20 calls/day; EOD all-world $19.99/mo; EOD+Intraday $29.99/mo; Fundamentals $59.99/mo; All-in-one $99.99/mo. | Broad global coverage, fundamentals, dividends/splits, news, options add-ons, official MCP/OpenAPI material. | Fundamentals are separate from the cheap EOD package; quality must be tested symbol-by-symbol before trusting scores. | Best “one vendor to test next,” especially for India/global fundamentals + corporate actions. |
| Financial Modeling Prep (FMP) | Free plan publicly advertises basic data; education material says free personal use can allow ~250 API requests/day; paid plans start around $49/mo depending plan. | Cheap/free fundamentals, statements, ratios, calendars, profile data. | Licensing/display terms and endpoint coverage vary by tier; quality can be uneven for edge symbols. | Good candidate to replace AV `OVERVIEW`, earnings calendar, ratios for US equities. Needs contract tests. |
| Twelve Data | Basic/free support page says 8 API credits / 800 per day; Grow starts around $29/mo. | Good for global OHLCV/intraday/forex/crypto, simple API. | Fundamentals are limited on cheaper tiers; credit model needs careful budgeting. | Candidate for quotes/candles, not first pick for fundamentals. |
| Finnhub | Free tier exists; paid stock API pricing pages show higher plans around $49.99+/mo, but some broad pricing surfaces mention enterprise/high-cost tiers. | News/events/alternative data can be useful; global API. | Pricing/limits are harder to reason about; some useful datasets are paid/high-tier. | Test only if a specific endpoint beats FMP/EODHD/Tiingo. |
| FRED/ALFRED | Free API key. | Official macro, vintages via ALFRED, avoids look-ahead bias. | Macro only; not stock data. | Should replace Alpha Vantage macro immediately when built. |
| TradingView paid account | No public data API. Paid plans can use webhook alerts; official support says no API for data/indicator values. | Excellent human charting, Pine prototypes, alerts/webhooks, manual validation. | Not a pull-based data source; cannot bulk-fetch candles/fundamentals into Kairos legally/officially. | Use as a human/alert signal source, not market-data backend. |

### Practical vendor short list

If trying to cut cost while improving quality:

1. **Test FMP free/cheap first for fundamentals.** It may replace a lot of Alpha Vantage `OVERVIEW`, ratios, earnings, and corporate profile calls at much higher daily volume than AV free.
2. **Test EODHD next if India/global fundamentals matter.** The $19.99 EOD plan is cheap for history, but the fundamentals package is closer to $59.99/mo. It may still be cheaper than stitching several unreliable sources together.
3. **Keep or replace Massive based on actual tier.** If you already have Massive Starter, it remains a good US price/history source. If you are on Massive Free and hitting 5 calls/minute, Tiingo Power or EODHD EOD+Intraday can be competitive.
4. **Use FRED/ALFRED for macro.** This is a no-brainer: free, official, better architecture than AV macro.
5. **Do not scrape TradingView as a data API.** Use TradingView alerts/webhooks to feed “human/Pine-confirmed signal events” into Kairos.

### Additional cheap/reliable candidates not in the first shortlist

This section exists because “cheap reliable data” is fragmented. Some sources are cheap because they are broker-tied, some because they only provide EOD/delayed data, and some because they are free but unofficial.

| Provider | Market | Cost signal checked | Strength | Weakness | Kairos verdict |
|---|---|---:|---|---|---|
| Alpaca Market Data | US | Free Basic exists; official docs say Free uses IEX, Algo Trader Plus gives full SIP/OPRA at higher tier. | Very strong cheap US price/history candidate, especially if delayed/EOD is acceptable. Good API and existing code stubs already exist. | Free real-time is IEX-only, not full-market SIP; full SIP is much pricier. Broker/account constraints may apply. | Strong candidate to test for US candles/history/quotes. Could replace some Massive usage if free delayed data is enough. |
| Tradier | US equities/options | Real-time data available to Tradier brokerage account holders; public pricing shows brokerage plans, API access. | Good if options chain/quotes matter and if opening/using Tradier account is acceptable. | Broker-coupled; not a generic public data vendor for non-account holders. | Useful later for options data/trading, not necessary today. |
| Marketstack | Global | Free 100 requests/month; Basic $9.99/mo 10,000 requests/month; Professional $49.99/mo 100,000/month. | Very cheap EOD/global coverage, splits/dividends/tickers on paid plans. | 100/month free is too small; must test quality/adjustments. | Worth contract-testing as cheapest global EOD/dividend/split source. |
| Stooq | US/global EOD/intraday files | Free downloadable historical datasets. | Very cheap/free for backfills and EOD history. | Not a polished authenticated API; coverage/timestamps/adjustments need testing. | Good backfill/cache seed source, not primary live source. |
| Nasdaq Data Link | US/global datasets | API platform; dataset-specific pricing/free availability. | Good for specialty datasets. | Not generally cheapest for broad US equity live/fundamental coverage. | Use only if a specific free/cheap dataset fills a gap. |
| Upstox API | India | Official page advertises ₹0/free access to trading and market-data APIs. | Potentially very strong free India alternative for live/historical candles if user can/has account. | Requires Upstox account/auth; exact data limits and reliability must be tested. | High-priority India test candidate before paying Kite/Dhan. |
| DhanHQ Data API | India | Dhan support says Data API subscription ₹499 + taxes/month; trading API free. | Official live WebSocket, quotes, historical, intraday; cheap and India-native. | Requires Dhan account/subscription; adds another broker/data relationship. | Strong paid India candidate; likely comparable/better than Kite paid data for data-only. |
| Angel One SmartAPI | India | SmartAPI sign-up/free materials; live market data API available. | Free/cheap India market feed candidate. | Reliability/support/terms and 2026 regulatory/API changes need review. | Worth testing after Upstox/Dhan; not first pick unless user already has Angel One. |

### Revised “most likely cheapest good stack”

If optimizing for low monthly cost before quality-perfect enterprise feeds:

#### US

1. **Alpaca Basic/free** for US historical/delayed bars and maybe IEX real-time where acceptable.
2. **Marketstack Basic $9.99/mo** or **Tiingo free/Power** for EOD/global backfill if Alpaca/Massive is insufficient.
3. **FMP free/cheap or FinancialDatasets credits** for fundamentals.
4. **SEC EDGAR + FRED** for official filings/macro.
5. Keep **Massive** only if its current tier is already paid/working well or if Alpaca/Marketstack quality tests fail.
6. Keep **Alpha Vantage free** only for niche endpoints until replaced; upgrade AV only if it remains the best source after contract tests.

#### India

1. Keep **Yahoo + NSE cache** as free baseline.
2. Test **Upstox API** first if Vaibhav can create/use an account; official site advertises free market data/trading APIs.
3. If Upstox is not viable, test **DhanHQ Data API** at ₹499 + taxes/month.
4. Compare **Kite Connect paid data** at roughly ₹500/month only if staying in the Zerodha ecosystem is more important than data features.
5. Test **Angel One SmartAPI** only if account setup/friction is low.

### Contract tests to decide vendor, not opinions

Before switching, run each candidate against the same test basket and score it:

| Test | Why |
|---|---|
| 1-year daily adjusted OHLCV for AAPL, NVDA, SPY, QQQ, TLT, GLD | Price/history baseline. |
| Split/dividend handling for AAPL/NVDA plus one dividend ETF | Prevent false P&L/backtest errors. |
| Fundamentals for AAPL, NVDA, small/mid cap, ETF | Check field availability and scaling. |
| India candles for RELIANCE, TCS, HDFCBANK, INFY | India coverage quality. |
| India corporate events/earnings where available | Ex-dividend/earnings planning. |
| Rate-limit simulation for daily cron volume | Proves the plan survives actual Kairos usage. |
| Timestamp/timezone consistency | Prevents look-ahead and stale-data bugs. |

No vendor should be promoted just because it is cheap. It should pass these contract tests and then be wired behind a provider abstraction with cache/provenance.

## Dimension coverage matrix — do the cheap sources cover everything Kairos uses?

No. The cheap/free sources collectively cover most dimensions, but not with equal reliability. The weak spots are sentiment/news quality, analyst revisions, ex-dividend/corporate actions for India, and official India fundamentals unless using a broker/data subscription or a broader global fundamentals vendor.

Legend:

- `Good` = usable as a primary source after contract tests.
- `Partial` = usable as supporting/advisory evidence, but not enough alone.
- `Weak` = unreliable, missing, unofficial, or too quota-limited.
- `Missing` = not covered by the candidate stack.

| Kairos dimension / flow | US current source | US cheaper/better candidate | US coverage verdict | India current source | India cheaper/better candidate | India coverage verdict | Notes |
|---|---|---|---|---|---|---|---|
| Tradable universe | Watchlist, Robinhood MCP, FinancialDatasets screener, ThemeScout | Robinhood MCP, Alpaca assets, Massive/Marketstack/Tiingo reference, TradingView screener CSV | Good | NSE equity CSV, watchlist, Kite holdings, India screen cache | NSE official CSV, Upstox/Dhan instruments, TradingView screener CSV | Good | Universe can be covered cheaply. Must avoid LLM-invented tickers. |
| Live executable quote | Robinhood MCP, Massive/AV fallback | Robinhood MCP at execution; Alpaca/Tradier if broker-linked | Good for US live if broker quote used | Yahoo quote for paper; Kite for order/account, not current market data on Personal | Upstox/Dhan/Kite paid data | Partial today; Good if paid broker data | For live orders, broker/exchange-backed quote should win. Yahoo should not be final execution quote. |
| EOD/intraday candles | Alpha Vantage, Massive, price_cache | Alpaca Basic, Massive, Tiingo, EODHD, Marketstack, Stooq for backfill | Good | Yahoo chart, NSE cache | Upstox, DhanHQ, Kite paid data, Yahoo fallback | Good if Upstox/Dhan/Kite paid; Partial if Yahoo only | Technicals are easy/cheap because RSI/EMA can be computed locally from candles. |
| Technical indicators | Local RSI/EMA from candles; AV RSI/EMA in scanner | Compute locally from Alpaca/Massive/Tiingo/EODHD/Marketstack candles; TradingView chart CSV for Pine/custom | Good | Local RSI/EMA from Yahoo/NSE cache; TradingView chart CSV | Upstox/Dhan/Kite paid candles + local compute; TradingView CSV | Good | Do not buy “technical indicator APIs” unless needed. Compute locally. |
| Fundamentals / company profile | AV `OVERVIEW`, FinancialDatasets | FMP, EODHD fundamentals, FD credits, Tiingo add-on/contact, TradingView screener CSV | Partial-to-Good depending vendor | Yahoo quoteSummary | EODHD global fundamentals, TradingView screener CSV, maybe Upstox/Dhan limited instrument metadata | Partial | This is one of the harder dimensions. US has cheap options; India fundamentals are weaker unless TradingView export or paid global fundamentals works. |
| Valuation ratios | AV, FD | FMP/EODHD/FD/TradingView screener CSV | Good after tests | Yahoo quoteSummary | TradingView screener CSV, EODHD/FMP if India supported | Partial | Need scaling tests: P/E, EPS, margins, ROE often differ by provider. |
| Earnings calendar/results | AV earnings calendar, Robinhood MCP earnings tools, Massive calendar elsewhere | FMP, EODHD, Nasdaq/SEC filings, Robinhood for held US names | Good | NSE event calendar, Yahoo per-symbol fallback | NSE events, Upstox/Dhan if available, TradingView screener/manual | Partial | India calendar can work but is less clean. |
| Dividends / splits / ex-dividend | AV `DIVIDENDS`/`SPLITS`, corporate actions route | EODHD, Marketstack paid, FMP, SEC/company actions, broker data | Good | Not robust today; Yahoo/NSE may expose some, not consistently wired | EODHD global corporate actions, TradingView screener/manual export, broker statements/Kite where available | Weak-to-Partial | Important gap because user explicitly cares about ex-dividend/tax. Needs dedicated source tests. |
| Insider transactions | AV `INSIDER_TRANSACTIONS`, SEC EDGAR route | SEC EDGAR primary; AV/FMP/EODHD fallback | Good | NSE PIT disclosures | NSE PIT disclosures; TradingView generally not enough | Partial | US should move to SEC as primary. India PIT is useful but feed can be brittle. |
| Congressional/political trades | House Stock Watcher | House Stock Watcher, Quiver/CapitolTrades-style paid if needed | Partial | Not India-relevant | N/A | N/A | Free data is okay for advisory, not core scoring. |
| News sentiment | AV `NEWS_SENTIMENT`, StockTwits | FMP/EODHD/Finnhub/news vendors, TradingView news manually, RSS/SEC/news scrape | Partial | Mostly missing; maybe Yahoo/NSE news not wired | TradingView alert/manual, RSS/news scrape, paid global news vendor | Weak | This is the largest cheap-data weakness. Free sentiment is noisy and quota-limited. |
| Social sentiment / social velocity | StockTwits + AV news proxy | StockTwits, Reddit scrape/API, Finnhub social if available, X not cheap | Weak-to-Partial | Not wired | Not cheap/reliable | Missing/Weak | Treat as optional. Do not block or trade solely on social. |
| Analyst ratings / target price / revisions | AV overview fields, Yahoo fields sometimes | FMP/EODHD/Finnhub/TradingView screener CSV | Partial | Yahoo targetMeanPrice sometimes | TradingView screener CSV; paid global fundamentals vendors | Weak-to-Partial | Revisions specifically are harder than static ratings. Need vendor contract test. |
| Options chain / options sentiment | AV realtime options, Yahoo options | Tradier if brokerage account, Alpaca paid OPRA, Massive options, Yahoo free advisory | Partial | NSE option chain OI/PCR | NSE option chain, Dhan/Upstox options APIs | Partial-to-Good | Current app uses options advisory, not core trading. Label OI as OI, not “flow.” |
| Macro indicators | AV macro | FRED/ALFRED | Good | Mostly US/global macro; India macro not strongly covered | RBI/MOSPI/public India macro APIs/manual sources TBD | US Good, India Partial | FRED/ALFRED should replace AV for US macro. India macro needs separate design. |
| Market regime / breadth | Massive sector/index quotes, local computations | Massive/Alpaca/Tiingo/Marketstack + local breadth; TradingView screener CSV | Good | Yahoo indices/sectors, NSE | NSE/Yahoo/Upstox/Dhan + local breadth | Partial-to-Good | Breadth can be computed from universe quotes if data provider supports batch enough. |
| Liquidity / volume filters | AV/Massive/Yahoo candles | Any candle provider + local avg volume | Good | Yahoo/NSE cache | Upstox/Dhan/Kite paid/Yahoo | Good | Cheap/easy if candles are reliable. |
| ETF holdings / sector exposure | AV ETF_PROFILE for sector holdings | Marketstack mentions ETF holdings on pricing page; EODHD/FMP may help; issuer pages | Partial | Not well covered | Manual/issuer/TradingView screener partial | Weak | Not core yet, but useful for ETF reasoning. |
| Broker account/positions/orders | Robinhood MCP, Alpaca stubs | Robinhood MCP for live US | Good | Kite | Kite/Upstox/Dhan/Angel depending broker | Good if broker chosen | Broker state is separate from market-data state. |
| Tax lots / realized P&L / wash sale / statements | Robinhood/Kite exports/broker docs | Broker statements/API if available | Partial | Kite statements/exports | Broker statements/API | Partial | Do not infer tax truth from market APIs. Broker tax docs are authoritative. |
| Embeddings / semantic journal | Voyage | Voyage/OpenAI/local embeddings | Good | Same | Same | Good | Not market data. |
| LLM synthesis | DeepSeek/Groq/Claude | Same, cost-routed | Good | Same | Same | Good | LLM must explain/triage, not supply prices/facts. |

### What the cheap stack covers well

- Price history/candles.
- Technical indicators, if computed locally.
- US macro if moved to FRED/ALFRED.
- US filings/insiders via SEC EDGAR.
- US/India universe discovery via exchange lists, broker instruments, and TradingView exports.
- India technicals/quotes for paper trading via Yahoo/NSE/Upstox/Dhan candidates.

### What remains weak or needs paid/provider tests

- High-quality sentiment/news.
- Social velocity.
- Analyst revisions, not just static ratings.
- India fundamentals at scale.
- India ex-dividend/corporate actions.
- Official executable India quotes unless using paid broker data.
- ETF holdings/fund composition.

### Recommended stance by dimension

| Dimension | Should be hard gate? | Why |
|---|---:|---|
| Price/quote/candles/liquidity | Yes | Cannot score/trade without real deterministic market data. |
| Technicals | Yes, if strategy uses technicals | Easy to compute; missing technical data should abstain. |
| Fundamentals | Partial gate | For equities, require enough fields; for ETFs, do not require company fundamentals. |
| Macro/regime | Advisory/gating only when data quality is high | Bad macro data can overrule too much. Use FRED/ALFRED. |
| Sentiment/social | No | Too noisy and source-fragile. Use as weak additive evidence only. |
| Insider/earnings/corporate actions | Event-risk gate | Missing ex-dividend/earnings data should reduce confidence or block event-sensitive trades. |
| TradingView signals | No direct trade gate | Use as evidence/candidate source; validate with paper/live outcomes. |

### How to use TradingView Pro/Premium in Kairos without an API

TradingView should become an **external signal generator / manual validation layer**, not the core data provider.

Recommended design:

1. Add a Kairos route such as `POST /api/tradingview/webhook`.
2. In TradingView, create Pine indicators/strategies for setups you care about: trend regime, RSI/EMA cross, volume breakout, volatility squeeze, sector-relative strength.
3. Configure TradingView alerts to send JSON webhook messages:

```json
{
  "source": "tradingview",
  "symbol": "{{ticker}}",
  "exchange": "{{exchange}}",
  "timeframe": "{{interval}}",
  "setup": "ema20_above_ema50_rsi_breakout",
  "direction": "long",
  "confidence": 0.65,
  "price": "{{close}}",
  "bar_time": "{{time}}"
}
```

4. Store those events in a new append-only table, e.g. `external_signal_events`.
5. ResearchAgent consumes them as **one evidence dimension**, not as truth:
   - “TradingView technical setup fired within last N bars”
   - “manual/Pine-confirmed”
   - never use it as the sole trade reason
6. LearnerAgent tracks whether TradingView-confirmed setups actually improved outcomes.

This gives you value from the paid TradingView account without violating the “no unofficial TradingView scraping as backend data source” rule.

### Deeper TradingView integration plan

TradingView has three safe/useful integration modes for Kairos:

#### 1. TradingView Screener CSV import — best for fundamentals + broad filters

TradingView’s official Screener export can export visible screen results to CSV. Since screener columns can include technicals and fundamentals, this is the cleanest way to use your paid TradingView data inside Kairos without scraping.

Use it for:

- broad candidate discovery;
- US + India screens where TradingView coverage is better than our free APIs;
- fundamentals that Alpha Vantage misses or rate-limits;
- technical ratings, volume, moving-average filters, relative performance, dividend yield, P/E, EPS/revenue fields, analyst rating fields where available.

Recommended Kairos feature:

- Add `/api/imports/tradingview-screener` and a UI import panel.
- User exports CSV from TradingView Screener.
- Kairos ingests rows into `external_screen_snapshots`.
- Columns are normalized into:
  - `symbol`
  - `exchange`
  - `market`
  - `as_of`
  - `price`
  - `volume`
  - `market_cap`
  - `pe`
  - `eps_growth`
  - `revenue_growth`
  - `dividend_yield`
  - `rsi`
  - `technical_rating`
  - `relative_volume`
  - raw JSON payload
- ResearchAgent can then use it as a “TradingView screener evidence” dimension, but still verifies price/quote from broker/Massive/Yahoo before trading.

#### 2. TradingView chart CSV export — best for indicator/backtest validation

TradingView’s chart export can include chart data and indicator values. This is valuable because Pine indicators can compute custom features that are annoying to reproduce elsewhere.

Use it for:

- validating a Pine setup against Kairos’ own calculations;
- importing indicator columns such as Supertrend, Anchored VWAP, custom relative strength, market structure, breadth proxies, volume profile-derived signals if exported;
- creating labeled datasets for LearnerAgent/Validation Engine.

Recommended Kairos feature:

- Add `/api/imports/tradingview-chart-csv`.
- Store rows in `external_indicator_observations`.
- Required columns: symbol, timeframe, bar time, OHLCV.
- Optional columns: any Pine/indicator output.
- Validation Engine compares:
  - TradingView indicator signal at bar close;
  - subsequent 5/10/20 trading-day return;
  - whether this signal improves over Kairos baseline.

Important: this should train/validate features, not directly cause trades.

#### 3. TradingView webhooks — best for real-time setup alerts

TradingView webhooks are the only good “live” integration path. Alerts can POST JSON to Kairos when your Pine condition fires.

Use it for:

- setup fired now;
- human-designed strategy alert;
- regime shift alert;
- volume breakout alert;
- “watch this symbol” signal.

Recommended Kairos flow:

1. TradingView alert fires.
2. `POST /api/tradingview/webhook` receives it.
3. Kairos stores append-only event in `external_signal_events`.
4. ResearchAgent promotes the symbol into today’s candidate queue.
5. Analyst scoring still pulls deterministic data and applies the evidence gate.
6. PaperTrader can test it; live trading remains approval-gated.

#### What not to do

Avoid:

- using unofficial TradingView websocket/private APIs as the main backend;
- browser automation to repeatedly export hundreds of screens/charts unattended;
- scraping TradingView financial pages;
- treating TradingView alert price as executable price;
- letting a TradingView alert directly place a broker order.

These are brittle and may create account/ToS/compliance risk. If used experimentally, keep it local/manual and do not make it production infrastructure.

#### Best role for TradingView in Kairos

TradingView should be the **human-grade signal lab**:

- You design screens and Pine rules.
- TradingView finds interesting candidates and setup events.
- Kairos ingests those as evidence.
- Kairos validates them statistically.
- Kairos decides whether they improve paper/live outcomes.

That is much more valuable than pretending TradingView is a hidden cheap data API.

### Contract-test before switching

Before replacing current sources, test each candidate on a fixed basket:

- US mega-cap: AAPL, MSFT, NVDA
- US mid-cap: 3–5 watchlist names
- ETF: SPY, QQQ, TLT, GLD
- India: RELIANCE.NS, TCS.NS, HDFCBANK.NS, INFY.NS
- Corporate actions: one dividend payer, one split history
- Earnings calendar: upcoming and recently reported names

For each provider, verify:

- adjusted close matches a trusted source within tolerance;
- split/dividend adjustment behavior is explicit;
- market cap, P/E, EPS, revenue growth fields are populated and correctly scaled;
- timestamps/timezones are clear;
- delisted/stale symbols do not silently return bogus current data;
- rate limits are high enough for the daily agent schedule.
