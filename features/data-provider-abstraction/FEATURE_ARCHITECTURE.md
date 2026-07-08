# Data Provider Abstraction + Per-Dimension Routing — FEATURE_ARCHITECTURE (DRAFT)

Status: **DRAFT — awaiting approval.** No code written yet.
Date: 2026-07-07
Trigger: `av_budget` hit 183 vs the 25/day free cap → ~70% of symbols get no real
technical/fundamental data every run (observed as technical=50 / fundamental=55
across GLD/IBIT/XAR). Root cause: every heavy per-symbol dimension is forced
through Alpha Vantage's 25/day free tier.

All provider capabilities below were verified live (2026) against official
provider docs, not assumed. Sources in MARKET_DATA_API_INVENTORY.md + this
session's research.

---

## 1. Problem (verified)

Per US research symbol, current code spends ~4 AV calls, all through
`avCachedFetch` which increments the single shared `av_budget` counter:

| Dimension | AV call | File |
|---|---|---|
| Technicals (candles) | `TIME_SERIES_DAILY_ADJUSTED` | `lib/research-agent.ts:608` |
| Fundamentals | `OVERVIEW` | `lib/research-agent.ts:622` |
| Insider | `INSIDER_TRANSACTIONS` | `lib/research-agent.ts:49` |
| News sentiment | `NEWS_SENTIMENT` | `lib/social-sentiment.ts:125` |

Plus two confirmed waste bugs:
- **FD eats AV budget** — `app/api/agents/research/scan/route.ts:80` routes
  FinancialDatasets `FD_SNAPSHOT` through `avCachedFetch`, incrementing
  `av_budget`. FD calls burn AV's 25 slots.
- **Scanner double-fetches** — `research/scan/route.ts:53,64,65` calls AV `RSI`,
  `GLOBAL_QUOTE`, `EMA50` per symbol, redundant with research's own candle
  fetch that already computes RSI/EMA locally.

24 symbols × ~4 calls = ~96 AV calls per run; two runs/day = ~190. Cap is 25.

---

## 2. Design — provider abstraction

Replace the single AV-specific `avCachedFetch` with a generic cached fetcher
keyed by provider, each with its own daily budget counter. NO trading-execution
code changes.

### 2a. `lib/data/providers.ts` (new)

```
type ProviderId = "alpha_vantage" | "massive" | "finnhub" | "fmp"
                | "alpaca" | "upstox" | "marketaux" | "gdelt" | "yahoo"
                | "sec_edgar" | "fred" | "financialdatasets";

interface ProviderSpec {
  id: ProviderId;
  dailyBudget: number | null;   // null = no daily cap (rate-limited only)
  budgetKey: string;            // av_budget-style counter row key
  keyEnv?: string;              // env var holding the key (absent = keyless)
  expiresAt?: string | null;    // ISO date the credential expires; null = never.
                                // For JWT tokens (Upstox), auto-derived by decoding
                                // the token's `exp` claim rather than hardcoding.
}
```

### Credential expiry tracking (user-requested)

Most keys never expire (Finnhub/FMP/FRED/Massive = indefinite until revoked).
Token-based providers do: Upstox (1yr JWT), Kite (daily), Robinhood (OAuth
refresh). The registry carries an `expiresAt` per provider:

- For **JWT tokens** (Upstox), `expiresAt` is derived by base64-decoding the
  token's `exp` claim at read time — no manual date entry, stays correct if the
  token is rotated. (Verified: current Upstox token exp = 2027-07-08.)
- For **static keys**, `expiresAt = null` ("No expiry").
- A daily `provider-credential-check` reporter (reuses the existing
  `lib/system-health.ts` issue funnel) raises a WARN at **30 days** before
  expiry and CRITICAL at **7 days / expired**, auto-resolving when the
  credential is refreshed. Same pattern already used for `broker-token:kite`.

### 2b. `providerCachedFetch(provider, cacheKey, url, opts)` (generalizes avCachedFetch)

Same reserve-before-spend + day-cache + stale-fallback logic already in
`av-cache.ts`, but:
- increments a **per-provider** counter (`provider_budget` table, keyed by
  `(provider, date)`), so FD no longer touches AV's budget;
- the 7-day stale-cache cap already added this session carries over;
- `avCachedFetch` becomes a thin wrapper: `providerCachedFetch("alpha_vantage", ...)`.

### 2c. Migration `NNN_provider_budget.sql`

- New `provider_budget(provider text, cache_date date, calls int, primary key(provider,cache_date))`.
- New `provider_budget_increment(p_provider text, p_date date)` RPC (mirrors
  `av_budget_increment`).
- Keep `av_budget` for backward-compat during rollout; migrate reads after.
- `av_cache` table reused as-is (already provider-agnostic by cache_key).

---

## 3. Per-dimension routing table (the core decision)

Primary → fallback chain per dimension. Fallback only fires when primary is
unavailable/over-budget. Availability-mask semantics (this session's fixes)
still apply: a dimension with no live data is EXCLUDED from weighting, never
scored as fake-neutral.

### US

| Dimension | Primary (new) | Fallback | Was | Provider notes (verified) |
|---|---|---|---|---|
| Candles/technicals | **Massive** (`/v2/aggs`) | Alpaca → AV | AV | Massive=Polygon rebrand, key already configured, no daily cap |
| Quotes | **Massive** (already) | Alpaca IEX → AV | Massive/AV | unchanged primary |
| Fundamentals | **FMP free** (250/day) | FD credits → AV | AV `OVERVIEW` | FMP 150+ endpoints, statements/ratios free |
| Insider | **SEC EDGAR** (free, unlimited) | AV | AV | EDGAR route already exists (`app/api/markets/edgar-insiders`) |
| News sentiment | **Finnhub free** (60/min) | Marketaux → GDELT | AV `NEWS_SENTIMENT` | per-ticker scores, free |
| Analyst ratings/revisions | **Finnhub free** | FMP | (none today) | NEW dimension — recommendation trends + price targets free |
| Earnings calendar | **Finnhub free** | AV | AV | free |
| Macro/regime | **FRED** (key added) | AV | AV | official, keyed, drafted next |
| Options (advisory) | Yahoo | — | Yahoo | unchanged |

### India

| Dimension | Primary (new) | Fallback | Was |
|---|---|---|---|
| Candles/technicals | **Upstox** (analytics token, free, hist to 2000) | Yahoo | Yahoo |
| Quotes | **Upstox** LTP | Yahoo | Yahoo |
| Fundamentals | **Upstox** (ISIN-keyed statements/ratios) | Yahoo quoteSummary | Yahoo |
| Corporate actions | **Upstox** (splits/div/bonus) | NSE/Yahoo | (weak today) |
| Insider/PIT | NSE `corporates-pit` | — | NSE (unchanged) |
| Execution | Kite (unchanged) | — | Kite |

Upstox verified: Analytics token = 1-yr, read-only GET, no static IP for data,
covers all four India data needs.

---

## 4. Keys required (user creates; Claude wires)

| Provider | Key/env | Free? | Needed for |
|---|---|---|---|
| Massive | `MASSIVE_API_KEY` (have) | yes | US candles/fundamentals/news |
| Finnhub | `FINNHUB_API_KEY` | yes | US news/analyst/earnings |
| FMP | `FMP_API_KEY` | yes (250/day) | US fundamentals |
| Upstox | `UPSTOX_ACCESS_TOKEN` | yes (1-yr) | India everything |
| FRED | `FRED_API_KEY` (added) | yes | US macro |
| Alpaca | `ALPACA_KEY_ID`/`ALPACA_SECRET` | yes | US fallback (optional) |
| Marketaux | `MARKETAUX_API_KEY` | yes | news fallback (optional) |

GDELT + SEC EDGAR = keyless.

Minimum to end the AV-limit problem: **Massive (have) + Finnhub + FMP + Upstox**.
Alpaca/Marketaux are fallback-only, deferrable.

---

## 5. Rollout (safety-first, no trading-behavior change)

1. Provider abstraction + `provider_budget` migration (no routing change yet).
2. Split FD off AV budget (`fdCachedFetch`) — immediate AV relief, zero new keys.
3. Kill scanner's redundant AV RSI/EMA/QUOTE calls.
4. Route US candles → Massive (key already present).
5. Wire Finnhub/FMP as keys land; each dimension behind a per-provider adapter
   with the existing availability-mask fallback (missing → excluded, not faked).
6. Route India → Upstox as token lands.
7. FRED macro adapter (drafted, enabled last).
8. Settings → Data Providers **capacity dashboard** (user-requested — "always
   know where the ceiling is"). Per provider, per market:
   - **Limit**: daily cap (FMP 250) or per-minute rate (Massive 5/min, Upstox
     500/min) or "no cap".
   - **7-day rolling average** real calls/day, from `provider_budget` history
     (the counter logs one row per provider per day, so the average is a plain
     query). Also today's live count.
   - **Headroom / projected ceiling**: `limit − avg`, and for capped providers a
     "days/× of growth until you hit the cap" figure (e.g. "FMP: 60/250 avg —
     room for ~4× your current universe").
   - **Cache hit rate** (real calls ÷ requested) so you see caching working.
   - **Credential expiry** date + days-remaining countdown (green >30d/no-expiry,
     amber <30d, red <7d/expired), driven by registry `expiresAt`.
   - **Bottleneck flag**: highlights whichever provider is closest to its ceiling
     so the single limiting dimension is always visible at a glance.

## 5b. Redundancy — every dimension has ≥2 sources (never starve)

Each dimension routes primary → fallback(s). Fallbacks fire automatically when
the primary is over-budget/rate-limited/erroring. Critically, EVERY dimension
already has a **keyless or already-owned** fallback, so agents never starve even
with zero extra signups:

All keys below are ADDED + live-tested unless marked. Fallback chains (primary
→ … → keyless) mean no dimension can fully starve.

| Dimension | Primary | Fallback 1 | Fallback 2 | Fallback 3 (keyless) |
|---|---|---|---|---|
| US candles/EOD | Massive | EODHD ✅ | Twelve Data ✅ | Alpha Vantage (have) |
| US fundamentals | FMP ✅ | EODHD ✅ | Massive financials | Alpha Vantage |
| US corporate actions | EODHD ✅ | AV | — | — |
| US news | Finnhub ✅ | Marketaux* | — | GDELT (keyless) |
| US insider | SEC EDGAR (keyless) | Alpha Vantage | — | — |
| US analyst | Finnhub ✅ | FMP ✅ | — | — |
| India candles/quotes | Upstox ✅ | — | — | Yahoo (keyless) |
| India fundamentals | Upstox ✅ | — | — | Yahoo (keyless) |
| India corp actions | Upstox ✅ | — | — | NSE/Yahoo (keyless) |
| Macro | FRED ✅ | Alpha Vantage | — | — |

\* = optional, not added. GDELT/Yahoo/SEC-EDGAR keyless → every row survives a
provider outage.

### LIVE-TEST CORRECTION (2026-07-08)

The prior research claim that EODHD/Twelve Data free tiers cover India NSE is
**FALSE — verified by hitting the APIs**:
- EODHD free `RELIANCE.NSE` → "Ticker Not Found" (NSE = paid tier).
- Twelve Data free `RELIANCE/NSE` → HTTP 404 "available starting with the Grow
  plan" (NSE = paid).

So **EODHD + Twelve Data add US redundancy only** on their free tiers. India
redundancy stays **Upstox (primary, has fundamentals+corp-actions) → Yahoo
(keyless)** — which is fine; Upstox is free and complete. Adding paid India
coverage (EODHD ~$60/mo or Twelve Data Grow) is deferred until/unless the free
Upstox→Yahoo chain proves insufficient. US now has 4-deep candle redundancy and
gains clean corporate-actions data (EODHD) that was previously weak.

### Capacity at expanded 20 US + 20 India fresh/day (+ holdings ≈ 40 US / 30 India)

| Provider | Limit | Load at 40 US/30 India | Verdict |
|---|---|---|---|
| Finnhub | 60/min, no daily cap | ~160 calls (~3 min) | fine |
| FMP | 250/day | ~80/day (40×2) | fine — still 3× headroom |
| Massive | 5/min, no daily cap | ~40 candle calls | fine w/ throttle |
| Upstox | 500/min, no daily cap | 30 India | fine |

20/20 expansion is comfortably within free tiers. FMP (the only daily cap) only
becomes the bottleneck past ~100 fresh US symbols/day — at which point Twelve
Data or Massive-financials absorb the overflow, or FMP $22/mo.

Each step is independently shippable and reversible. Steps 2–4 need **no new
keys** and alone likely get US under the 25/day AV cap.

---

## 6. Out of scope (explicitly not this feature)

- TradingView integration (no data API — signal-webhook feature, separate track).
- Any paid tier (EODHD/Twelve Data/Massive Starter) — only if free proves short.
- Order-execution / broker changes — untouched.
- Sector-median P/E (needs a sector-median data source — separate).

---

## 7. Open questions for approval

1. Approve the routing table as-is, or adjust any primary/fallback?
2. Build all 8 rollout steps, or start with the no-new-key relief (steps 1–4)
   and pause for keys before 5–7?
3. Data Providers panel (step 8) now, or defer as its own UI task?
