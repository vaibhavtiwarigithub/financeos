# ChatGPT Review Request — Data-Provider Abstraction + New Signal Features

You are doing an **adversarial code review** of a batch of features just added to
"Kairos" (a Next.js 15 / TypeScript / Supabase multi-market trading research app
for US + India equities). Find **logic bugs, wiring mistakes, architecture
problems, data-flow errors, and correctness issues.** This is a real-money-
adjacent system (it scores stocks and generates paper + live trade proposals),
so a wrong number or a silently-swallowed error matters.

Do **not** rewrite the code. Produce a **findings document** (format at the
bottom). Only report issues you can point to concretely in the code — no style
nits, no speculation. If an area is clean, say so in one line.

---

## What was built (the scope to review)

The problem being solved: every per-symbol research dimension was fetched
through **Alpha Vantage's free tier (25 calls/day)**, so the daily budget blew
out (hit 183/25) and ~70% of symbols got no real technical/fundamental/macro
data — they fell back to neutral baselines that were then mis-scored as real
signals. The fix spreads each dimension across dedicated providers, each with
its own budget, plus adds new signal sources.

### Files added
- `lib/data/provider-fetch.ts` — generic `providerCachedFetch(provider, cacheKey, url, opts)`. Per-provider daily budget counter (Supabase RPC `provider_budget_increment`), day-cache in `av_cache` table (keyed by globally-unique `cacheKey`), reserve-before-spend, fail-closed on counter error, serve last-known cached payload (≤7 days old) on throttle/over-budget/failure. Providers with `dailyBudget: null` (Massive, Finnhub, Upstox, FRED) have no daily cap but still log calls.
- `lib/data/candles.ts` — US daily candles: `fetchUsCandles(symbol, avFallback, minCandles=15)` tries Massive → EODHD → Twelve Data → (caller's AV fallback), returns first source with ≥15 bars. Each source is its own day-cached fetch. Candles feed local RSI/EMA computation.
- `lib/data/fundamentals.ts` — US fundamentals via FMP `/stable/ratios-ttm` + `/stable/key-metrics-ttm`, mapped into the Alpha-Vantage-`OVERVIEW` shape that `scoreFundamentals` (in `lib/data/scores.ts`) reads (`PERatio`, `ProfitMargin`, `EPS`, `ReturnOnEquityTTM`, `Symbol`). `fetchUsOverview(symbol, avFallback)` requires ≥2 real fields before trusting FMP, else falls back to AV.
- `lib/data/edgar-insider.ts` — SEC EDGAR Form 4 insider scoring (`scoreEdgarInsider`), CIK map cached 24h in module memory, 90-day buy/sell-value ratio, `available:false` on <3 transactions or non-US symbol.
- `lib/data/fred-macro.ts` — `fredSeries(seriesId, limit)` for FRED economic series, day-cached under the `fred` provider.
- `lib/data/upstox.ts` — India candles via Upstox official API. Resolves ticker→`NSE_EQ|<ISIN>` instrument key via the `upstox_instruments` table (migration 101), lazily refreshed weekly from Upstox's gzipped NSE instrument master. `fetchUpstoxCandles(symbol)` → v3 historical-candle → oldest-first `Candle[]`.
- `lib/data/analyst.ts` — `scoreAnalyst(symbol)` from Finnhub `/stock/recommendation`, weighted consensus 0-100, ≥3-analyst minimum. Returned as `{score, evidence, available}`.
- `lib/data/earnings.ts` — `fetchDaysToEarnings(symbol, india)`, US via Finnhub earnings calendar, India via Yahoo.
- `app/api/data-providers/route.ts` — owner-gated capacity dashboard feed (per-provider limit, today's calls, 7-day avg from `provider_budget_7d` view, headroom, JWT expiry decode for Upstox, bottleneck flag).
- `app/api/india/smart-money/route.ts` — surfaces NSE FII/DII flows + block/bulk deals.
- migrations `100_provider_budget.sql` (table + increment RPC + 7d view), `101_upstox_instruments.sql`.

### Files modified (wiring)
- `lib/av-cache.ts` — `avCachedFetch` is now a thin wrapper over `providerCachedFetch("alpha_vantage", ...)`.
- `lib/research-agent.ts` — the core `processSymbol` orchestration:
  - Added `applicableDimensions(entry)` — a structural map of which dimensions a symbol CAN have (ETFs: no fundamentals/insider/analyst; India: no US-style insider/social/analyst; US ADRs like INFY/BABA/TSM: no insider since foreign private issuers don't file Form 4). Every fetch is gated on it.
  - US candles now `fetchUsCandles(...)`, US fundamentals now `fetchUsOverview(...)`, insider now `resolveInsider(symbol, avKey)` = SEC EDGAR → AV fallback.
  - India candles now Upstox → Yahoo fallback.
  - Analyst (`scoreAnalyst`) + days-to-earnings (`fetchDaysToEarnings`) fetched and **logged into `decision_observations.features`** (`.analyst`, `.days_to_earnings`) — deliberately NOT fed into the live weighted score (they're captured for the LearnerAgent to validate first, per project doctrine).
- `app/api/agents/macro-sentinel/route.ts` — all 8 macro indicators rewired from AV economic endpoints to FRED series (DGS2/DGS10, UNRATE, PAYEMS, GDPC1, CPIAUCSL, RSAFS, FEDFUNDS, DGORDER). Signal thresholds unchanged. Payrolls now computes month-over-month change from the PAYEMS level; CPI now true YoY (v0 vs 12-months-ago).
- `app/api/agents/research/scan/route.ts` — the scanner's FinancialDatasets snapshot call moved from `avCachedFetch` to `providerCachedFetch("financialdatasets", ...)` so FD no longer consumes AV's budget.
- `lib/nse-data.ts` — added `fetchNseFiiDii()` and `fetchNseBigDeals()` reusing the existing cookie-gated `nseApi()` helper.
- `app/dashboard/settings/page.tsx` — new "Data" tab rendering the capacity dashboard.

---

## Specific things to scrutinize (high-value review targets)

1. **`providerCachedFetch` cache-key collisions & budget correctness.** The response cache is the shared `av_cache` table keyed only by `cacheKey`. Every caller must pass a globally-unique, provider-prefixed key. Grep all call sites (`MASSIVE_CANDLES:`, `EODHD_CANDLES:`, `TD_CANDLES:`, `FMP_RATIOS:`, `FMP_KEYMETRICS:`, `FD_SNAPSHOT:`, `FRED:`, `UPSTOX_CANDLES:`, `FINNHUB_REC:`, `FINNHUB_EARN:`, plus the legacy AV keys `RSI:`, `OVERVIEW:`, `GLOBAL_QUOTE:`, `DAILY_ADJ:`, `INSIDER:`, `NEWS:`) — **are any two keys collidable across providers?** Also: for no-daily-cap providers, the budget increment is fire-and-forget (`.then(()=>{},()=>{})`) — is that correct, or does it create a race where the dashboard undercounts?

2. **Field-mapping correctness in `fundamentals.ts`.** FMP's `netProfitMarginTTM`, `returnOnEquityTTM` are fractions (0.27 = 27%); `scoreFundamentals` in `scores.ts` expects `ProfitMargin`/`ReturnOnEquityTTM` in the same fraction scale as Alpha Vantage. **Verify the scales actually match** — a units mismatch (e.g. FMP returns a percent where AV returns a fraction, or vice versa) would silently distort every US fundamental score. Same check for `PERatio` (`priceToEarningsRatioTTM`) and `EPS` (`netIncomePerShareTTM`).

3. **Candle chronology.** `scoreTechnicals`/`computeTechnicals` require **oldest-first** candles for EMA. Massive returns ascending (sort=asc), EODHD ascending (order=a), Twelve Data returns newest-first (the code sorts it), Upstox v3 returns newest-first (the code sorts it). **Verify every candle source ends up oldest-first** before it reaches the technical computation, and that the `.NS`/`.BO` handling doesn't break the US path or vice versa.

4. **`applicableDimensions` correctness vs the actual fetch gating.** Cross-check: does the gating in `processSymbol`'s `Promise.all` exactly match what `applicableDimensions` says? E.g. sentiment is gated `applicable.has("sentiment") && !india` — is the `&& !india` redundant or does it contradict the map? Are there dimensions still fetched that the map says are inapplicable, or vice versa (fetched-then-scored inconsistency)?

5. **The FRED macro rewrite semantics.** For each of the 8 indicators, verify the FRED series ID is the right economic series AND that the transformation matches the old signal intent (the payrolls MoM-change and CPI YoY changes are the risky ones — confirm the math and that `fredSeries` returns enough readings: CPI needs ≥13, payrolls needs ≥5, etc. — does the code guard the length before indexing `[12]`/`[i+1]`?).

6. **Upstox instrument-key resolution & lazy refresh.** `getInstrumentKey` refreshes the whole 85k-row master if a symbol is missing AND the table is stale. **Can this cause a thundering-herd / long-latency stall** during a research run (multiple India symbols each triggering a refresh)? Is the "stale → refresh → retry once" logic correct, and does a fresh-but-genuinely-missing symbol correctly return null without refreshing every time? Is the gzip parse (`gunzipSync`) safe on a serverless function (memory/timeout)?

7. **`fetchUsCandles` / `fetchUsOverview` fallback semantics.** When Massive returns e.g. 10 bars (< minCandles 15), it falls to EODHD — but the 10 bars are discarded. Is that intended? For fundamentals, `fetchUsOverview` requires ≥2 fields from FMP before trusting it — does the AV fallback then correctly fill, or can a symbol end up with an empty overview when FMP had 1 usable field (worse than either source alone)?

8. **Analyst / days-to-earnings logging.** These are logged into `decision_observations.features` but explicitly NOT scored. Confirm they truly don't leak into the weighted score anywhere (grep for `.analyst`, `days_to_earnings`, `analystResult` in `research-agent.ts` and the scoring path). Confirm the availability gating (`applicable.has("analyst")`) prevents wasted Finnhub calls on ETFs/India/ADRs.

9. **NSE FII/DII + deals parsing.** `fetchNseFiiDii` and `fetchNseBigDeals` parse undocumented NSE JSON with many `??` fallbacks. Are the field names plausibly correct for the real NSE endpoints (`/api/fiidiiTradeReact`, `/api/block-deal`, `/api/bulk-deal`)? Does the net-tone logic in the route handle the FII-buying / DII-selling divergence correctly? Does an empty/blocked NSE response degrade cleanly (it's advisory)?

10. **The capacity dashboard feed.** `app/api/data-providers/route.ts` — the JWT expiry decode (`jwtExpiryIso`) for Upstox: is the base64url→base64 conversion correct, and does it fail safe for non-JWT keys? The `financialdatasets` key-present check is hardcoded `true` "may live in vault" — is that misleading? Does the bottleneck computation correctly ignore no-cap providers?

11. **Architecture / consistency.** Is `providerCachedFetch` the single choke point, or do any new fetchers bypass it (raw `fetch` with no caching/budget)? Are timeouts, error handling (try/catch returning `[]`/`{}`/`null`), and the availability-mask contract (missing data → excluded from weighted score, never faked as neutral) consistent across all 8 new adapters?

12. **Anything else** — off-by-one, wrong-variable, unhandled null, a `Promise.all` element that can reject and kill the whole batch, a migration that's schema-coupled to code that shipped before it was applied, a `.NS` symbol reaching a US-only provider, etc.

---

## Output format (so fixes can be applied mechanically)

Return a markdown findings document. For each finding:

```
### [SEVERITY] Short title
- **File:** path/to/file.ts:LINE (or LINE-RANGE)
- **Issue:** one sentence, what's wrong
- **Why it matters:** concrete failure scenario (what input → what wrong output)
- **Fix:** precise instruction a junior dev can apply mechanically — exact change, not "consider refactoring"
```

Severity = CRITICAL / HIGH / MED / LOW. Order the document most-severe first.
End with a one-line list of areas you verified are clean. Be specific with line
numbers; if you can't see a line number, quote the exact code snippet the
finding refers to.
