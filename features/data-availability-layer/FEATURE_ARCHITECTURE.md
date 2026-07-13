# Feature Architecture — Data Availability Layer

> Status: **PROPOSAL — draft, Codex-reviewed, not built.** Needs owner sign-off. NOTHING here is wired into the running app yet — the shipped US fundamentals chain is still Finnhub → FMP → AV; SEC + US-Yahoo fundamentals are proposal-only. "Endpoint returns data" ≠ "integrated + correct metric".
> Scope: guarantee no scoring dimension / agent flow is ever starved of input data on a max-symbol day, using only free + already-keyed sources.
> Last updated: 2026-07-13
> Update when built: `docs/arch/02-tech-stack.md`, `docs/arch/03-agents.md`, `docs/arch/05-crons-and-scheduling.md`, `docs/arch/09-learning-loop.md`, `public/agent-diagrams/system-map.json`.

## One-line decision

Put a **Data Availability Layer** in front of ResearchAgent: a **paced, cache-first
refresh cron** fills Supabase evidence caches ahead of scoring; ResearchAgent scores
from cache snapshots and only makes bounded, last-resort live calls. Resilience for
thin dimensions (fundamentals) comes from **cache TTL + stale-serve + pacing**, NOT
from fallback breadth — because on the free tier the fallbacks mostly do not exist.
(Design from the Codex review, corrected to only live-validated sources.)

## Why not "just add more fallbacks inside processSymbol()"

- Vercel serverless: no shared in-memory rate state across invocations, and a cron
  can't spin-wait 17 min for a 5/min provider. Synchronous per-symbol fallback
  chains blow both the cron `maxDuration` and the provider limits.
- On a max day (measured: **US 42 symbols, India 13**), synchronous scoring would
  need ~84 Massive calls (5/min) and 84 Finnhub calls (60/min) in one burst.

## LIVE-VALIDATED provider truth (tested 2026-07-13 — the correction to Codex)

Every entry below was hit with the real key this session. **A provider may only
enter a chain after it is live-validated; "documented as free" is not enough**
(FMP, FinancialDatasets, TwelveData, EODHD all *looked* usable and were not).

| Dimension | Market | Provider | Result | In chain? |
|---|---|---|---|---|
| Fundamental | US | Finnhub `/stock/metric`+`/profile2` | ✅ works (PE, margin, ROE, EPS, rev-growth, sector) | **primary** |
| Fundamental | US | Yahoo `quoteSummary` (crumb) | ✅ endpoint returns data (profitMargins, returnOnEquity, revenueGrowth, **forward**PE, sector; fraction-scaled). **Unofficial** — no published quota, discretionary throttling, ToS restricts automated use. | **opportunistic (forward-looking fields)** |
| Fundamental | US | SEC EDGAR `xbrl/companyfacts` | ✅ endpoint returns data (Revenues, NetIncomeLoss, EPS, StockholdersEquity). Free/no-key; **fair-access ~10 req/s, no published daily quota** (NOT unlimited). Needs CIK map + price for P/E, and careful **period selection** (see Metric Equivalence). | **primary reported/accounting** |
| Fundamental | US | FMP `/stable/ratios-ttm` | ❌ premium-gated on free | no |
| Fundamental | US | FinancialDatasets snapshot | ❌ $0 credit balance | no |
| Fundamental | US | TwelveData `/statistics` | ❌ premium-only (403) | no |
| Fundamental | US | EODHD `/fundamentals` | ❌ free = EOD prices only | no |
| Fundamental | US | Massive `/financials/v1/ratios` | ❌ plan NOT_AUTHORIZED | no |
| Fundamental | India | Yahoo `quoteSummary` (crumb) | ✅ endpoint returns data for `.NS` (RELIANCE.NS: margin 0.076, ROE 0.091, rev-growth 0.125, sector Energy). **Unofficial, single source — resilience NOT solved, only coverage.** Crumb flow already exists in `lib/india-data.ts`. | **monitored single-source primary** |
| Fundamental | India | Finnhub (NSE) | ❌ "no access to this resource" | no |
| Fundamental | India | TwelveData / EODHD (NSE) | ❌ premium / symbol-not-found | no |
| Sentiment | US+India | GDELT `tonechart` | ✅ works for any company name, free, no daily cap | **backbone** |
| Sentiment | US | StockTwits | ⚠️ unreliable (frequent 403) | opportunistic first |
| Sentiment | US | AV `NEWS_SENTIMENT` | ✅ but 25/day HARD cap | reserve only |
| Insider | US | Massive `/filings/vX/form-4` | ✅ works (P/S transaction detail) | **primary** |
| Insider | US | SEC EDGAR Form 4 | ✅ free/official (was returning unavailable in practice — re-verify) | secondary |
| Insider | India | NSE corporate PIT disclosures | ⚠️ exists in `lib/nse-data.ts` — UNVALIDATED for scoring | validate before claiming |
| Technical | US | Massive aggregates | ✅ works | primary |
| Technical | US | TwelveData `/time_series` | ⚠️ on free tier (8/min, 800/day) — validate | secondary |
| Technical | US | AV daily | ✅ capped | reserve |
| Technical | India | Yahoo chart | ✅ works (`lib/india-data.ts`) | primary |
| Technical | India | Upstox candles | ⚠️ `UPSTOX_ACCESS_TOKEN` present — validate | secondary |

### Honest verdicts (corrected after Codex review 2026-07-13)
"Endpoint validated" (the URL returns the fields with our key/handshake) is NOT the
same as "integrated + reliable." The three US sources are **not interchangeable** —
they carry different metric bases and must be used in DISTINCT roles, not treated as
equivalent fallbacks:
- **SEC EDGAR = primary reported/accounting fundamentals** (TTM margin, ROE, revenue
  growth from official XBRL). Per-field coverage varies: sampled AAPL/MSFT/NVDA/JPM
  covered; TSM is IFRS (different taxonomy), BRK.B lacked the standard diluted-EPS
  tag. So coverage is measured **per field**, not "universal third provider."
- **Finnhub = primary profile + computed-ratio fields** (sector, TTM P/E, EPS).
- **Yahoo = opportunistic forward-looking fields** (forwardPE) + the SOLE India
  source. Unofficial — pace + fail-soft + monitor; never a guaranteed backbone.
- **AV OVERVIEW = capped emergency reserve.**
- **US fundamentals: genuine multi-source, but role-split, not "3 equal fallbacks."**
- **India fundamentals: coverage exists (Yahoo) but resilience does NOT — single
  unofficial source.** Keep the explicit single-source risk; on failure →
  `provider_unpriceable` + renormalize (like ETFs), never faked neutral 50.
- ETFs legitimately have no fundamentals/insider — "not applicable," never starvation.
- **Reality gap:** these are PROPOSAL-only for US. Current shipped US chain is still
  Finnhub → FMP → AV (`lib/data/fundamentals.ts`); SEC + US-Yahoo are NOT wired yet,
  so they do not protect the running app until built.

## Corrected provider chain matrix (endpoint-validated; role-split, not equal fallbacks)

| Dimension | Market | Ordered chain |
|---|---|---|
| Fundamental | US | **reported** SEC EDGAR (TTM) + **profile/ratios** Finnhub + **forward** Yahoo (opportunistic) → AV `OVERVIEW` (reserve) → stale-cache-serve. Each field records which source+basis served it. |
| Fundamental | India | Yahoo quoteSummary (crumb, monitored single-source) → stale-cache-serve → else `provider_unpriceable` |
| Technical | US | Massive → TwelveData `/time_series` *(if validated)* → AV daily (reserve) |
| Technical | India | Yahoo chart → Upstox *(if validated)* |
| Sentiment | US | StockTwits (opportunistic) → GDELT tonechart → AV NEWS (reserve) |
| Sentiment | India | GDELT tonechart → NSE announcements *(if validated)* |
| Insider | US | Massive Form 4 → SEC EDGAR → AV (reserve) |
| Insider | India | NSE PIT *(if validated)* → else not-enough-data |

(Twelve Data `/time_series`, Upstox, NSE PIT, Yahoo-crumb each carry a **validation
gate** — a live probe that must pass before the source is enabled in config. This
gate is the durable fix for the "looked wired, wasn't" failure mode.)

## Metric equivalence + provenance (the hard part — Codex correction)

Different providers report the SAME dimension on DIFFERENT bases. Swapping a
provider must never silently change what a score MEANS. So every fundamental field
is stored with provenance, and derived metrics use consistent periods:

- **Per-field provenance:** store `metric_basis` (e.g. `ttm` | `forward` | `annual` |
  `quarterly`), `period_end`, `source`, `taxonomy` (`us-gaap` | `ifrs`), and
  `fetched_at` for EACH field — not one label for the whole overview.
- **SEC period selection (must not take "latest" blindly):** companyfacts mixes
  annual, quarterly, and YTD observations. The adapter must:
  - TTM margin from **matching-period** TTM revenue and TTM net income (sum of 4
    consecutive quarters, same units), not latest annual ÷ latest quarterly.
  - ROE on **average equity** ((begin+end)/2), not the latest ending equity.
  - Revenue growth from **equivalent periods** (TTM vs prior TTM, or FYvsFY).
  - Handle **US-GAAP and IFRS** tags (TSM sampled as IFRS); fall through when the
    standardized tag is absent (BRK.B lacked the standard diluted-EPS tag).
  - Keep **TTM P/E** (SEC EPS + price) distinct from Yahoo/Finnhub **forward** P/E —
    never blend the two into one field.
- **Per-field coverage, not per-provider:** SEC covers major facts for most large
  caps but NOT all fields for all issuers, so availability is tracked at the field
  level. A field with no consistent-period value is `genuine_no_data`, and the
  fundamental score renormalizes over the fields it DOES have.
- The scorer already renormalizes over available dims; extend that to **available
  fields within** the fundamental dimension so partial SEC coverage still scores.

## Architecture

### 1. Cache-first evidence store
Per (symbol, market, dimension): `evidence_cache(symbol, market, dimension, payload,
source_used, fetched_at, ttl_days, stale_ok)`. ResearchAgent reads this, never the
provider directly.

### 2. Per-dimension freshness TTL (the real load-killer)
On a 42-symbol day, most symbols already have fresh evidence, so few live calls fire.
- Fundamentals: **14 days** (financials change quarterly).
- Insider: 1–3 days.
- Sentiment: 1 day.
- Technicals: current trading day / latest EOD.

### 3. Priority classes (whom to freshen first, not "trim to 3")
1. Held live/paper positions — always freshen.
2. Open candidates likely to cross threshold — second.
3. Watchlist — third.
4. Broad screener names — last; may score on stale fundamentals.
Score ALL applicable symbols; only *freshen* expensive dims for priority 1–2 daily.

### 4. Supabase-backed pacing (not in-memory — serverless-safe)
- `provider_limits(provider, min_interval_ms, daily_budget, burst, enabled)`
- `provider_call_ledger(provider, started_at, cache_key, status, http_status, throttle_reason)`
- `provider_refresh_jobs(provider, symbol, dimension, market, priority, status, next_attempt_at)`
- `providerCachedFetch()`: fresh-cache-hit → return; else acquire a **Supabase lease
  via RPC/advisory lock** enforcing `last_started_at + min_interval_ms <= now()`; no
  slot → return stale cache + enqueue a refresh job. **Never spin-wait in Vercel.**
- Min gaps: Massive 12.5s, GDELT 5.5s, TwelveData 7.8s, AV 15s (+ hard daily reserve),
  Finnhub 1.2s, SEC 250–500ms, Upstox/Yahoo/NSE 1–2s cache-first.

### 5. Refresh cron separate from research cron — BOUNDED + resumable
A prewarm/refresh cron drains `provider_refresh_jobs` at each provider's safe pace
BEFORE the research cron runs. Research scores from warm cache; live calls become
bounded exceptions. **A single Vercel function cannot run ~17 min** (Hobby caps
~60s; even Pro maxDuration is bounded) — so the prewarm CANNOT be one long drain.
Instead: each invocation processes only as many jobs as fit in a hard wall-clock
budget (e.g. ≤45s), leases per-provider slots, marks jobs `next_attempt_at`, and
**returns** — leaving the rest queued. The job is scheduled to fire repeatedly
(pg_cron every few minutes) so the queue drains across MANY short invocations,
never one long one. State lives in Supabase (`provider_refresh_jobs` +
`provider_call_ledger`), so progress survives across invocations. Cold-start of a
full 42-symbol universe simply takes several prewarm ticks, not one function call.

### 6. Starvation invariant + telemetry (first-class)
**Invariant:** *No applicable scoring dimension may be unavailable solely because a
provider budget/rate/burst limit was exhausted. It may be unavailable only because
every configured source returned genuine no-data, the symbol is structurally
inapplicable, or no validated free source exists for that market/dimension.*
- Per symbol/dimension record: `applicable, available, source_used,
  source_chain_attempted, unavailable_reason`.
- Reasons: `not_applicable | genuine_no_data | provider_rate_limited |
  provider_daily_budget | provider_auth_missing | provider_unpriceable |
  stale_cache_used | chain_exhausted`.
- System Health (extends the existing low-confidence-research alert):
  `data-availability:<market>:<dimension>` — warn < 85% availability, critical < 70%,
  detail names the throttled/exhausted provider.

### 7. Evidence provenance labels
Fix stale "Alpha Vantage" labels in the journal to show the real `source_used`
(Finnhub / Yahoo / GDELT / Massive / SEC).

## Capacity proof (max day: US 42, India 13) — after TTL + prewarm
With 14-day fundamental TTL and priority-class freshening, a steady-state day
freshens only priority-1–2 fundamentals (~5–10), all sentiment (1-day TTL) via GDELT,
insider (1–3d) via Massive. Worst-case COLD start (empty cache) is absorbed by the
prewarm cron over its window, never the scoring cron:
- AV: target 0, ≤10 reserve; **never 42** → under 25/day. ✅
- Finnhub: ≤ (priority fundamentals × 2) paced at 1.2s → seconds. ✅
- Massive: prewarmed at 12.5s gaps → ~17 min cold, off the scoring path. ✅
- GDELT: ≤ (US+India sentiment) at 5.5s → prewarm window. ✅
Any chain that still can't cover 42 (e.g. India fundamentals) is reported as
`provider_unpriceable`, not silently starved.

## Build order
1. **Stop the AV sentiment drain (biggest, quickest win):** US sentiment →
   StockTwits → GDELT tonechart → AV reserve. Drops AV from ~42 to ~0 calls/day.
2. Supabase-backed pacing (`provider_limits` + ledger + lease RPC) in
   `providerCachedFetch()`.
3. Config-driven source chains (registry per dimension×market with validation gates).
4. Data-availability telemetry + System Health alerts.
5. Prewarm/refresh cron + `evidence_cache` + TTL + priority classes.
6. Fix evidence provenance labels.
7. Build + validate the fundamentals sources properly (endpoints already return
   data; what remains is the ADAPTER work, not endpoint discovery):
   - SEC companyfacts adapter with correct TTM/avg-equity/period-matched derivation,
     US-GAAP+IFRS taxonomy handling, symbol→CIK map, and per-field coverage tracking.
   - US Yahoo `quoteSummary` adapter (forward-looking fields), crumb cache + fail-soft.
   - Still-unvalidated ⚠️ sources (Upstox, TwelveData `/time_series`, NSE PIT/
     announcements) each behind a live probe before enabling.
   Note: "endpoint returns data" ≠ "correct metric" — sign-off requires the
   period-equivalence checks above, spot-checked against ≥5 names per market.

## Riskiest assumption
Fundamentals redundancy now rests on two **unofficial** sources (Yahoo quoteSummary,
and Finnhub's free tier) plus one official (SEC EDGAR, US-only). The residual risks:
1. **Yahoo is unofficial** — the crumb/cookie flow or field shapes can change without
   notice; it is the SOLE India fundamentals source. Mitigation: cache aggressively
   (14-day TTL), fail soft to `provider_unpriceable`, and health-alert if Yahoo's
   India availability drops. A second India source (e.g. Screener.in/Tickertape
   scrape, or NSE fundamentals) remains an open follow-up — nice-to-have, not blocking.
2. **EDGAR needs a maintained symbol→CIK map + a price** to derive P/E; margin/ROE/
   growth come straight from XBRL. Low risk (official, stable) but more mapping code.
The earlier "no free India fundamentals source" blocker is RESOLVED (Yahoo `.NS`
live-validated), so this is no longer a launch blocker — just a monitoring concern.

## Non-negotiables
- Free cloud only — never a paid tier/proxy/VPS. Every source free + keyed in vault/Vercel.
- Deterministic — no LLM on the scoring/fallback path.
- Forward-only — no backfill of historical signals.
- Per-market / per-currency isolation; US and India chains independent.
- A source enters a chain ONLY after a live validation probe passes.
