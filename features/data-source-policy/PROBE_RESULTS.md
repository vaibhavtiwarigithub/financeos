# Phase 0 — Webull Data-Tool Contract Probe Results

> Captured 2026-07-14 03:06 UTC via `POST /api/broker-mcp/webull/probe-data?symbol=AAPL`
> fired through `kairos_call_agent` (real **unattended cron context**, not an
> interactive session). Response id 554, status 200. This file is the ground
> truth the Phase 1 Webull adapter parsers + tests must match. No parser predates it.

## Headline findings

1. **`category:"US_STOCK"` is REQUIRED, not optional.** Every bare `{symbol}` call
   returned `-32603 "Internal error: Failed to <tool>: No fallback available."`.
   Only `{symbol, category:"US_STOCK"}` returned 200. → the current
   `lib/data/webull-data.ts` (sends bare `{symbol}`) gets an error on *every* call.
   The Webull research integration produces **zero** data in production today.
2. **Cron entitlement CONFIRMED.** This probe ran via the pg_cron helper, i.e. the
   same unattended path a scheduled research run uses. 200 for all four tools. The
   architecture doc's riskiest assumption (§23.1 — data tools entitled off-session)
   is resolved in favor of the design.
3. **All four payload shapes match the architecture doc's §3 claims**, with ONE
   correction: `get_financial_indicators` is **quarterly** (no `type:ANNUAL` arg);
   the doc's §13 "Request explicit type (ANNUAL)" is wrong for this tool.

## Captured payloads (AAPL, `category:"US_STOCK"`)

### get_analyst_rating
```json
{ "symbol":"AAPL", "category":"US_STOCK", "number":"47",
  "strong_buy":"22", "buy":"6", "hold":"17", "under_perform":"1", "sell":"1",
  "effective_start_date":"2026-07-08T18:21:43.000+0000" }
```
- Counts are **strings**. `number` = total analysts = 22+6+17+1+1 = 47 (validates).
- Buckets: `strong_buy, buy, hold, under_perform, sell`. No `strong_sell` key.
- Consensus weights (per doc §13): strong_buy=100, buy=80, hold=50, under_perform=20, sell=0.
- **Current parser bug:** `deriveRatingScore` maps `under_perform` only via keys
  `ratingUnderPerform/strong_sell/ratingStrongSell` — it does NOT list `under_perform`,
  so that bucket is dropped and the denominator is understated. (Moot until category fixed.)

### get_analyst_target_price
```json
{ "symbol":"AAPL", "category":"US_STOCK",
  "mean":"315.56667", "low":"215", "high":"400", "median":"315",
  "currency":"USD", "effective_start_date":"2026-07-08T18:21:43.000+0000" }
```
- String numerics. Preserve mean/median/low/high/currency/effective_start_date.

### get_stock_forecast_eps  (ARRAY of fiscal periods)
```json
[ {"fiscal_year":2025,"fiscal_period":3,"actual":"1.567683","est":"1.42572","reported":true},
  {"fiscal_year":2025,"fiscal_period":4,"actual":"1.847869","est":"1.76993","reported":true},
  {"fiscal_year":2026,"fiscal_period":1,"actual":"2.842403","est":"2.6708","reported":true},
  {"fiscal_year":2026,"fiscal_period":2,"actual":"2.008574","est":"1.94439","reported":true},
  {"fiscal_year":2026,"fiscal_period":3,"est":"1.89428","reported":false} ]
```
- Forward EPS = the row with `reported:false`, field `est` (here 2026 Q3 = 1.89428).
- **Current parser bug:** `unwrapRecord` → `data[0]` = the FIRST (oldest, reported past)
  row, and reads `actual` — wrong period AND wrong field. Confirmed.

### get_financial_indicators  ({currency, values:{metric:[{fy,fp,value}]}})
```json
{ "currency":"USD",
  "values":{
    "net_margin":[{"fiscal_year":2026,"fiscal_period":2,"value":"0.2660"}, ... 5 quarters ...],
    "roe":[{"fiscal_year":2026,"fiscal_period":2,"value":"0.3039"}, ...],
    "roa":[{"fiscal_year":2026,"fiscal_period":2,"value":"0.0788"}, ...],
    "debt_to_assets":[...], "diluted_eps_incl_extra":[...], "naps":[...],
    "ocf_ps":[...], "cap_surplus_ps":[...] }}
```
- **QUARTERLY**: `fiscal_period` ∈ 1–4, last 5 quarters, newest first. No `type` arg exists.
- Ratios already **fractions** (net_margin 0.2660 = 26.60%, roe 0.3039). Do NOT /100.
- **Basis = quarterly.** TTM must be derived (sum 4 quarters for flows); single-quarter
  net_margin ≠ TTM. Tag basis quarterly per invariant #7 — never label it annual/TTM.
- **Current parser bug:** `walk()` recurses only non-array objects; each metric is an
  array, so it is skipped → `{}` → null. Confirmed no usable data.

## Corrections to FEATURE_ARCHITECTURE.md before Phase 1
- §13 Fundamentals: remove "Request explicit `type` (ANNUAL)". Tool is quarterly-only;
  request no type, take the array, tag basis=quarterly, derive TTM separately (tested).
- §3 / §19: the payload contract is now **verified**, not hypothesized. Fixtures above
  are the Phase-1 test baseline. Still capture MSFT/JPM/BRK.B/ETF/no-data before shipping.
