# Broker-Compatible Research Universe — Stage 0 Evidence

**As of:** 2026-10-20
**State:** partial; no Stage 1 catalog approval
**Authority:** measurement-only. This report changes no score, candidate queue,
position, order, broker setting, or live-trading state.

## Executive result

The Alpaca paper credentials now work in production and the existing evidence
shadow successfully captured adjusted daily bars for seven US symbols. This is a
useful source validation—not evidence that Alpaca can replace the current price
source, not consolidated-market pricing, and not a basis for expanding the live
research queue. The regular US ResearchAgent is already deferring work, and US
classification coverage is incomplete. Stage 0 therefore remains partial.

## Evidence collected

### Alpaca: credentials and data contract

- The production read-only evidence worker recorded 8 Alpaca daily-bar calls in
  the last seven days: 7 successful fresh results and 1 `auth_missing` result
  before the production credential configuration was corrected.
- Seven current cached symbols—BE, CELH, COP, CRNT, CRWV, DBA, and DLR—each have
  219 adjusted daily bars, from 2025-12-05 through 2026-10-20. Each payload is
  explicitly marked `IEX (Alpaca Basic; not consolidated SIP)`.
- A separate read-only Alpaca MCP query asked for the latest ten calendar days
  of IEX daily bars for 24 liquid symbols across multiple industries (AAPL,
  MSFT, NVDA, AMZN, META, JPM, BAC, XOM, CVX, LLY, JNJ, UNH, WMT, COST, CAT,
  GE, NEE, DUK, V, MA, AVGO, TSLA, HD, KO). All 24 returned seven sessions
  (168 bars total, 2026-10-12 through 2026-10-20). This direct connected-provider
  probe is separate from Kairos's scheduled production provider-call ledger.
- This is a seven-symbol smoke sample, not a stratified coverage study. It does
  not prove reliability for all VOO constituents, delisted names, or the broader
  equity universe, nor does it measure price agreement against the canonical
  source.
- A read-only Alpaca `/v2/assets` check returned 14,396 active US-equity assets,
  13,505 marked tradable, and 13,197 tradable non-OTC. These are Alpaca's asset
  records and capabilities, not Robinhood eligibility and not historical
  membership.

Alpaca's official documentation describes Basic as free for individual Trading
API users and limited to IEX real-time equities data; the listed Basic limits are
30 WebSocket symbols and 200 historical API requests/minute. Its historical-data
documentation describes IEX as one exchange at about 2.5% of US market volume;
SIP is the consolidated multi-venue feed. The asset endpoint is a master list of
assets available for trade and data consumption on Alpaca. Therefore Alpaca Basic
is suitable for a bounded research/diagnostic comparison, but not as a sole
intraday execution-price authority.

Sources: [Alpaca Market Data API plans](https://docs.alpaca.markets/us/docs/about-market-data-api),
[Alpaca historical stock data feeds](https://docs.alpaca.markets/us/v1.1/docs/historical-stock-data-1),
[Alpaca asset master endpoint](https://docs.alpaca.markets/us/reference/get-v2-assets-1).

### Current research workload and source completeness

Production `agent_runs`, `universe_snapshots`, and `provider_call_ledger` were
queried read-only for 2026-10-20:

- US regular run: 101 eligible, 73 succeeded, 28 deferred (53 held names and 20
  new candidates in the workload metrics); it took about 105 seconds.
- US discovery-only run: 15 of 15 succeeded in about 42 seconds.
- India regular/discovery passes completed their bounded 8–15-symbol worklists;
  Alpaca is US-only and is not an India price source.
- In the previous seven days the price/fundamental source ledger recorded
  397 Kairos daily-bar calls with no recorded failures, 92 EODHD calls with 10
  failures, 124 Massive daily-bar calls with 81 `genuine_no_data` results, 8
  Alpaca calls with 1 pre-configuration `auth_missing`, and 48 Robinhood quote
  calls with 4 failures (3 rate-limited). Many provider failures are explicitly
  typed `genuine_no_data` or `not_applicable`; they are not all transport
  outages. The Alpaca shadow has not yet established cross-provider agreement or
  fallback value at scale.
- `symbol_profiles` currently has 250 US rows; 169 have sector and exchange,
  none have industry populated, and 235 were updated in the last 90 days. This
  is insufficient classification coverage for a broad sector-aware measurement
  universe.

The small current daily research queue is not the same as the market universe.
Increasing full per-symbol scoring now would grow already-deferred work and
increase expensive/provider fan-out before a new selector has been measured.

### Public reference sources

- Nasdaq's symbol directories expose Nasdaq-listed and other-exchange listed
  current records and say they update during the day. They are not a historical
  membership archive. Nasdaq's page distinguishes unrestricted Nasdaq Events
  data from the separate Nasdaq Fund Network content with internal/noncommercial
  terms; do not treat all Nasdaq products as having the same license.
- SEC ticker/CIK files are useful identity corroboration, but the SEC explicitly
  does not guarantee their accuracy or scope. CIK is an issuer identity, not a
  security-classification or broker-tradability source.
- NYSE states complete reference-data products separately; a free full historical
  cross-exchange master has not been proven in this Stage 0 review.

Sources: [Nasdaq symbol directory definitions](https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs),
[Nasdaq symbol lookup](https://nasdaqtrader.com/trader.aspx?id=symbollookup),
[SEC EDGAR ticker/CIK caveat](https://www.sec.gov/files/about/webmaster-faq.htm),
[NYSE reference data](https://www.nyse.com/market-data/reference).

## Decision against expanding the daily queue today

Do not raise the full US ResearchAgent cap or send every S&P 500/VOO holding
through fundamentals/news/LLM daily. The current regular pass defers 28 of 101
eligible symbols, and the independent discovery lane is already completing 15
per run. The correct next experiment is a deterministic, persisted shadow
shortlist from a frozen, quality-checked measurement universe, compared on the
same sessions with the incumbent queue and a liquidity-only control. The
incumbent selection, scoring, and trading paths stay untouched until that study
is approved and has mature paired outcomes.

## Stage 0 exit checklist

| Requirement | State | Evidence / remaining gap |
|---|---|---|
| Alpaca credentials and daily-bar adapter | Partial pass | Seven production cached symbols each have 219 bars; a separate IEX MCP probe returned 7/7 bars for 24 liquid symbols. One pre-configuration auth miss; no all-VOO coverage or price-agreement test. |
| Feed scope and source identity | Pass with restriction | Payloads visibly identify IEX; not consolidated SIP. |
| Broker universe identity | Partial | Alpaca asset master only describes Alpaca records; Robinhood has no documented bulk enumeration in the connected adapter. |
| Current US exchange directories | Partial | Nasdaq current lists are available; NYSE full security-master and terms still need confirmation. |
| Historical point-in-time membership | Fail / not available from these sources alone | Current lists/assets cannot substantiate historical membership. |
| Sector/industry classification | Fail for broad cohort | Only 169/250 US profiles have sector/exchange and 0/250 industry in current cache. |
| Price/bar coverage and practical workload | Partial | Seven-symbol Alpaca check is not a stratified coverage sample; regular run deferred 28 names. |
| $2m/$5m/$10m ADV20 arms | Not measured | Do not freeze liquidity policy or select an arm based on P&L. |
| Robinhood capability probes | Partial | Small sampled quote calls only; not a bulk inventory; 3 rate-limited calls in seven days. |
| Licensed, reproducible source contract | Not complete | Terms, NYSE scope, classification contract, and retention policy need a named decision. |

## Next safe actions

1. Keep the Alpaca IEX adapter in the existing evidence-shadow lane and let its
   scheduled stratified probes accumulate; do not route it into deterministic
   scores or order/stop pricing.
2. Once a declared sample covers the current US research symbols across sectors,
   report success, stale/missing rates and daily-bar agreement against the
   existing canonical source. Require a minimum sample and multiple market days
   before considering score-source routing.
3. Complete the reference-source/terms and classification provider decision,
   including the NYSE gap and source retention. SEC associations remain
   corroborative only.
4. After Stage 0 gates pass, propose—not silently apply—the Stage 1 catalog,
   immutable membership snapshots, and source licensing/retention migration.
5. Keep day trading separately gated. Daily bars and a 7-symbol smoke test do
   not establish fresh intraday quotes, reliable streams, order preview/fill
   quality, cancellation behavior, or protective-order lifecycle.
