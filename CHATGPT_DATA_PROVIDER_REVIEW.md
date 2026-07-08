# ChatGPT Data Provider Review Findings - 2026-07-08

### [HIGH] SEC Form 4 insider adapter treats every acquired share as an open-market buy
- **File:** `lib/data/edgar-insider.ts:40-44`
- **Issue:** `parseForm4Xml()` classifies transactions from `<transactionAcquiredDisposedCode>` (`A`/`D`) instead of `<transactionCoding><transactionCode>`, so acquisitions from awards, option exercises, grants, or other non-open-market events can be counted as insider "buys."
- **Why it matters:** A Form 4 with transaction code `M`/`A` and acquired/disposed code `A` can be scored as bullish buying even though it is not an open-market purchase; `scoreEdgarInsider()` can then raise the insider score and influence a trade signal with false evidence.
- **Fix:** Parse `transactionCode` from `<transactionCoding>` and only count `P` as buy and `S` as sell. Treat `M`, `A`, `F`, `G`, `J`, option awards/exercises, and zero-price rows as `other`; keep `transactionAcquiredDisposedCode` only as supplemental metadata, not the buy/sell classifier.

### [HIGH] India smart-money big-deal parser is broken against live NSE responses
- **File:** `lib/nse-data.ts:165-182`
- **Issue:** `fetchNseBigDeals()` calls `/api/bulk-deal`, which returned HTTP 404 in a live check, and parses `/api/block-deal` rows using fields that are not present in the live response (`clientName`, `buySell`, `quantityTraded`, `tradePrice`).
- **Why it matters:** On 2026-07-08, `/api/block-deal` returned fields like `symbol`, `totalTradedVolume`, `totalTradedValue`, and `lastPrice`; current code maps those rows to `side: "sell"`, `qty: 0`, and `price: 0`. The UI can show false "sell" smart-money activity, or no bulk deals at all.
- **Fix:** Replace `/api/bulk-deal` with the current NSE bulk-deal endpoint if one is available, or remove the bulk branch until verified. For block deals, map `qty` from `totalTradedVolume`, `price` from `lastPrice`, and set `side: "unknown"` unless the endpoint supplies a real buy/sell field. Do not default unknown side to `"sell"`.

### [MED] FinancialDatasets screener POST calls still bypass provider budget/cache
- **File:** `lib/research-agent.ts:287-305` and `app/api/agents/research/scan/route.ts:25-48`
- **Issue:** `screenBucket()` and `screenFundamentals()` call `https://api.financialdatasets.ai/stocks/screener/` with raw `fetch`, so these FinancialDatasets calls are not counted in `provider_budget`, do not respect the FD daily cap, and cannot serve cached fallback.
- **Why it matters:** A normal research run calls the momentum and value screeners in parallel before per-symbol scoring. If FD is near its quota, the capacity dashboard can show available headroom while the screener is still spending untracked calls and failing silently to `[]`.
- **Fix:** Extend `providerCachedFetch()` to support `method`, `body`, and cache-key hashing, then route these POST calls through `providerCachedFetch("financialdatasets", "FD_SCREENER:<hash(filters,limit)>", ...)`. If supporting POST in the generic helper is too large, add a small `providerCachedPost()` wrapper with the same budget increment and stale-cache behavior.

### [MED] Candle cache keys ignore lookback length/date range
- **File:** `lib/data/candles.ts:15-22`, `lib/data/candles.ts:34-40`, `lib/data/candles.ts:53-58`, `lib/data/upstox.ts:65-75`
- **Issue:** `fetchMassiveCandles()`, `fetchEodhdCandles()`, `fetchTwelveDataCandles()`, and `fetchUpstoxCandles()` build URLs from `days`, `from`, and `to`, but cache only by symbol (`MASSIVE_CANDLES:${symbol}`, `EODHD_CANDLES:${symbol}`, `TD_CANDLES:${symbol}`, `UPSTOX_CANDLES:${bareSymbol(symbol)}`).
- **Why it matters:** If any caller asks for `days=30` and later another caller asks for `days=160` on the same UTC date, the second call can receive the 30-day cached payload. That can drop below the 50-day EMA requirement, mark technicals missing, or trigger unnecessary fallback calls.
- **Fix:** Include the requested lookback or actual date range in every candle cache key, e.g. `MASSIVE_CANDLES:${symbol}:${days}` or `MASSIVE_CANDLES:${symbol}:${fmtDate(from)}:${fmtDate(to)}`. Do the same for EODHD, Twelve Data, and Upstox.

### [MED] Evidence provenance still records new providers as Alpha Vantage
- **File:** `lib/data/scores.ts:289-318` and `lib/research-agent.ts:849-875`
- **Issue:** `writeBatchEvidence()` hardcodes `source: "alpha_vantage"` for fundamentals, OHLCV, and insider evidence even though the new path can source fundamentals from FMP, candles from Massive/EODHD/Twelve Data/Upstox/Yahoo, and insiders from SEC EDGAR.
- **Why it matters:** The evidence store becomes misleading: an FMP-derived P/E or SEC-derived insider score is logged as Alpha Vantage. That breaks later debugging, source-quality analysis, and any LearnerAgent audit that needs to know which provider produced a correct or bad signal.
- **Fix:** Preserve resolver source strings. In `processSymbol()`, keep the full result from `fetchUsOverview()` and `fetchUsCandles()` instead of discarding `.source`; have `resolveInsider()` return `{ ..., source: "sec_edgar" | "alpha_vantage" }`; pass those sources into `computeScores()` or a new evidence-write context and use them in `writeBatchEvidence()`.

### [MED] Upstox instrument-master refresh can stampede under concurrent missing symbols
- **File:** `lib/data/upstox.ts:49-60`
- **Issue:** `getInstrumentKey()` refreshes the full gzipped instrument master when a symbol is missing and the table is stale, but there is no lock or "refresh in progress" guard.
- **Why it matters:** If multiple India research requests start with an empty/stale `upstox_instruments` table, each missing symbol can download, gunzip, parse, and upsert the same large master file. That can create long latency, memory pressure, and duplicate DB writes during a cron run.
- **Fix:** Add a DB-level refresh lock before `refreshInstruments()`, e.g. `pg_try_advisory_lock()` via RPC or a single-row `provider_refresh_state` table with `provider='upstox_instruments'`. If another request owns the lock, wait briefly/retry the lookup once, then fall back to Yahoo instead of starting another refresh.

### [MED] No-cap provider call logging can undercount in serverless/runtime termination
- **File:** `lib/data/provider-fetch.ts:114-118`
- **Issue:** For providers with `dailyBudget: null`, `provider_budget_increment` is fire-and-forget and not awaited.
- **Why it matters:** In a serverless or route-handler context, the request can finish before the promise is flushed. The capacity dashboard can undercount Massive/Finnhub/Upstox/FRED usage, hiding per-minute pressure and making 7-day averages unreliable.
- **Fix:** Await the RPC but keep it non-fatal: `try { await svc.rpc(...) } catch {}` before the fetch, or run it after a successful real fetch if the dashboard should count successful calls rather than attempts. Do not let logging failure block the provider fetch.

### [LOW] Earnings proximity is fetched for ETFs even though the dimension is structurally inapplicable
- **File:** `lib/research-agent.ts:888-891`
- **Issue:** `fetchDaysToEarnings(symbol, india)` runs for every symbol, while `applicableDimensions()` explicitly excludes company-level analyst/fundamental dimensions for ETFs.
- **Why it matters:** US ETFs such as `SPY`, `QQQ`, `GLD`, or leveraged ETFs can still spend a Finnhub earnings-calendar call even though there is no single-company earnings date to learn from. On uncapped-but-rate-limited Finnhub, this wastes per-minute capacity.
- **Fix:** Add an `"earnings"` dimension to `Dimension` and `applicableDimensions()`, or gate directly: `const daysToEarnings = !isEtf ? await fetchDaysToEarnings(symbol, india).catch(() => null) : null;`. If India ETFs are later added, apply the same structural skip.

### [LOW] FinancialDatasets credential status is hardcoded as present
- **File:** `app/api/data-providers/route.ts:51-56`
- **Issue:** `keyPresent` is forced to `true` for `financialdatasets` even when `FINANCIAL_DATASETS_API_KEY` is absent from env and the route has not checked the vault.
- **Why it matters:** The Data Providers dashboard can show FD as configured while `getFDKey()` in research/scan routes returns an empty key, causing screeners and snapshots to silently degrade to no candidates/no fundamentals.
- **Fix:** Query `api_key_vault` for `FINANCIAL_DATASETS_API_KEY` in this owner-gated route, or return a third state such as `keyStatus: "env" | "vault" | "missing" | "unknown"`. Do not report `keyPresent: true` unless env or vault actually has the key.

## Clean areas verified

FRED series calls request `sort_order=desc` and guard CPI/payroll lengths before indexing; US and Upstox candle adapters sort/return oldest-first; FMP margin/ROE mapping is on the fraction scale expected by `scoreFundamentals`; analyst consensus and `days_to_earnings` are logged to `decision_observations.features` and do not feed the live weighted score; `applicableDimensions()` mostly matches fetch gating for fundamentals/sentiment/options/insider; capped providers use atomic reserve-before-spend and fail closed to stale cache; the capacity dashboard bottleneck calculation ignores no-cap providers as intended.
