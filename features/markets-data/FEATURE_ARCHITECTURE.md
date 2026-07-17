# Markets Data — Price-Cache Fill Architecture

> Status: **Implemented** (2026-07-15)
> Scope: the Markets page display tiles only. **Never** on the money / scoring / sizing / order path.

## Problem

The Markets page (`components/dashboard/MarketsPage.tsx`) renders ~30 ETF tiles:

- **Regime proxies** — SPY, QQQ, IWM, TLT, IEF, HYG, UUP, GLD, VIXY, DIA
- **11 sector XLs** — XLK, XLF, XLE, XLV, XLI, XLY, XLC, XLP, XLU, XLRE, XLB
- **Leveraged sentiment pairs** — TQQQ/SQQQ, SOXL/SOXS, SPXL/SPXS, FAS/FAZ, UGL/GLL

Each tile group had its own API route that fetched its symbols with a **concurrent
burst** of per-symbol Massive `/prev` calls on page load:

- `app/api/markets/synthesis/route.ts` — `Promise.allSettled(REGIME_TICKERS.map(fetchQuote))` (8–9 concurrent)
- `app/api/markets/overview/route.ts` — 15 symbols in parallel
- `app/api/markets/quotes/route.ts` — up to 20 symbols in parallel (the leveraged pairs)
- `app/api/charts/sector-returns/route.ts` — 11 sectors, staggered but still bursty

Massive's **free tier rate-limits at ~5 requests/minute** (confirmed: `HTTP 429 —
"You've exceeded the maximum requests per minute"`). So most of each burst 429'd and
`Promise.allSettled` silently dropped the rejected quotes → IWM/TLT/HYG/UUP/GLD and the
leveraged pairs rendered `—`. Worse, `markets/synthesis` then **cached the degraded read**
(briefings table, `session='synthesis'`) for the whole day, so a single unlucky page load
froze a mostly-empty synthesis until someone manually force-refreshed. `charts/sector-returns`
reads a `price_cache` table that nothing proactively filled, so Sector Performance / Breadth
showed "Price cache empty".

**Free-cloud-only constraint:** upgrading Massive's tier is off the table. The fix has to
live entirely within ~5 req/min.

## Solution: one paced daily fill, then read the cache

### 1. Daily fill job — `app/api/agents/price-cache-fill/route.ts`

Runs pre-market on weekdays (pg_cron, see below). Cron-gated (`verifyCronSecret`) for the
scheduled run, owner-gated for manual runs (`requireOwner`). `maxDuration = 60`.

**Pacing — the key move.** Massive is Polygon-compatible, so it exposes the **grouped-daily**
aggregates endpoint:

```
GET https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true
```

This returns **every US ticker's** prior-session OHLC in **one call** (~12k rows). The fill
job makes that single request, filters the result to our 31-symbol universe, and upserts into
`price_cache`. So the entire daily fill costs **one Massive request** — it respects the ~5/min
limit trivially, with no burst and no long pacing loop. The most-recent completed session is
resolved by walking back from yesterday over weekdays (a market holiday just yields an empty
grouped result and we step back another day); at most a handful of paced attempts.

**Fallback** (only if the grouped endpoint is ever unavailable / entitlement-denied): sequential
per-symbol `/prev`, gated by the shared serverless-safe `try_acquire_provider_slot` lease
(12.5 s = 5/min), **bounded** to a 45 s wall-clock budget and **resumable** — it only fetches
symbols missing the expected session, so the 13:45 retry tick (and subsequent days) drain any
remainder. This mirrors the `prewarm` / `evidence-shadow` bounded-resumable pattern.

**Idempotency.** Before doing anything (unless `?force=1`), it probes `price_cache` for a marker
symbol (SPY) at the most-recent session and **skips** if already filled. Upserts are keyed by the
`price_cache` primary key `(symbol, date)`.

**Health.** Emits a System Health `warn` (`reportIssue`, key `price-cache-fill-degraded`,
auto-expires at UTC midnight) **only on a large shortfall** (<60 % of the universe filled, or the
fallback made zero progress). A clean fill calls `resolveIssue`. A couple of illiquid names
missing from one snapshot is normal and does **not** alert.

### 2. Tiles read the warm cache

- **`markets/synthesis`** now reads the latest `price_cache` bar per regime ticker in **one batch
  query** (`readCachedQuotes`), computing `changePct = (close − open) / open` from the cached
  daily bar (identical to what `/prev` returned). Only symbols still missing from the cache are
  backfilled, and that backfill is **sequential + lease-gated** (`fetchQuotePaced`) so it can never
  burst. Normal page loads resolve entirely from cache → **zero Massive calls on load**.
- **`markets/quotes`** already had a `price_cache` fallback (it computes change from the last two
  closes); once the cache is filled the leveraged pairs resolve from it.
- **`charts/sector-returns`** reads `price_cache` and is kept warm by the daily fill. Its own lazy
  backfill remains as a cold-start safety net. **Superseded assumption (corrected 2026-07-17):**
  this section previously claimed "the cache accumulates history over successive fills", implying
  the 1W/1M/3M/6M/1Y windows would fill themselves in. They do not on any useful horizon — the
  daily fill adds ONE session per weekday, so a 1Y window needs a year of ticks. See
  "Sector period windows" below for the honesty guard and the explicit backfill that replace it.
- **`markets/overview`** keeps its 5-minute in-memory + Next `revalidate` cache; it benefits from
  the warm provider state but was not the frozen-for-a-day offender.

### 3. Never cache a degraded synthesis

`markets/synthesis` now only writes its daily briefings cache when a **strong majority** of the 7
regime scoring signals resolved (`scored >= 5`). A sparse read (cache not filled yet, or a transient
Massive failure) is returned to the caller but **left uncached**, so the next fill / regeneration
completes it instead of freezing it for the day.

### 4. Macro "what this means for your book" stays fresh

`app/api/agent-mind/macro-read` already regenerates daily via `kairos-macro-read-us/india` crons and
returns a `stale` flag when its cached date ≠ today. The `MacroReadCard` on the Markets page now
**self-heals**: on load, if the read is stale it auto-triggers one regeneration (guarded by a
`useRef` one-shot, reset when the market flips) so the card is never frozen on a previous day's text.
Advisory-only, cached per day → at most one cheap LLM call per viewer per day.

## Schedule

pg_cron (migration `20260715140000_price_cache_fill_cron.sql`), verified registered in prod
`cron.job` (jobid 71/72, active):

| Job | Schedule (UTC) | Calls |
|---|---|---|
| `kairos-price-cache-fill` | Weekdays 13:25 | `POST /api/agents/price-cache-fill` |
| `kairos-price-cache-fill-retry` | Weekdays 13:45 | `POST /api/agents/price-cache-fill` |

Both fire before the 14:00 UTC morning briefing. 13:25 UTC ≈ 9:25 AM ET pre-market. EDT/EST caveat:
set for EDT (summer); shift +1h at the November changeover, consistent with the other `kairos-*` jobs.

## Invariants preserved

- **Free-cloud-only** — one Massive request/day; no paid tier, no VPS.
- **Deterministic** — prices and the regime scoring math are pure data; the LLM is used **only** for
  the advisory synthesis / thesis / macro-read prose, never for prices or the regime call.
- **Per-market never mixed** — this fill is US ETFs only. India tiles keep their own Yahoo/GDELT
  sources (`IndiaSectors`, `IndiaBreadth`, `IndiaGapNote`); US-only tiles stay US-only.
- **Off the money path** — `price_cache` is display data. Nothing here feeds scoring, sizing, or
  orders.
- **Mobile-first** — no UI layout changes; the existing responsive tiles just get real data.

## Sector period windows — honesty guard + backfill (2026-07-17)

### The defect

Markets → Sector Performance switching 1W/1M/3M/6M/1Y did not change the data. `price_cache` held
exactly **two** sessions per sector ETF (2026-07-14, 2026-07-15), because the daily fill had only
been scheduled two days earlier and adds one session per tick. Every cutoff (`now − 7/30/90/180/365`)
therefore preceded both bars, every window selected the SAME two bars, and every period returned the
SAME one-day move.

**This was an honesty bug, not just missing data.** The guard was `if (candles.length < 2) return
null` — a COUNT check, not a SPAN check. Two bars pass it and produce a number the UI renders as
"1Y XLK return +2%" when it is a one-day move. A display asserting a period the data cannot support
is a false return.

### The contract — `lib/markets/sector-returns.ts` (pure, unit-tested)

A window may only report a return when the cached bars **actually span it**. Otherwise `returnPct:
null` plus a machine-readable `reason` the UI renders as what/why/next. Three independent checks,
each covering a different failure mode — all are load-bearing:

| Check | Constant | Catches |
|---|---|---|
| Start edge — oldest bar within N days of the cutoff | `START_GRACE_DAYS = 4` | Missing EARLY history on long windows (6 months of data must never be labelled 1Y). 4 days because the longest run of consecutive non-trading calendar days is 3 (holiday-adjacent weekend); exact-match would false-reject every window. |
| Span coverage — `span >= days × floor` | `MIN_SPAN_COVERAGE = 0.4` | DEGENERATE spans on short windows. The absolute grace cannot protect a 7-day window: observed 2026-07-17 with 2 bars, the 1W cutoff (07-10) sat exactly 4 days before the oldest bar (07-14), so both edge checks passed and a 1-day move was served as a "1W return" of −1.11%. 0.4 sits below the worst legitimate 1W (holiday week, span 3/7 = 0.43) and above the degenerate case (1/7 = 0.14). |
| End edge — newest bar within N days of today | `STALE_GRACE_DAYS = 7` | A window ending at a stale point — a "1Y return" ending three weeks ago is not a 1Y-to-today return. |

Reason codes: `no_data`, `single_bar`, `insufficient_history`, `stale_cache`. `summariseCoverage()`
folds the per-sector rows into one note; the UI renders it verbatim (never a bare "—").

### PostgREST 1000-row cap (found by the backfill)

`sector-returns` batch-read all 11 ETFs unpaginated. PostgREST caps a response at **1000 rows**; a
full 1Y window is ~273 × 11 ≈ 3000, so it silently returned only the four alphabetically-first
sectors (XLB, XLC, XLE, XLF) complete and the other seven with ZERO rows. Latent while the cache
held 22 rows; it bit the instant real history landed. The read is now paginated. The honesty guard
degraded correctly here — it reported `no_data` rather than inventing a number.

### Backfill

See `docs/arch/05-crons-and-scheduling.md`. ~400 days of daily bars for the 11 sector XLs, **one
provider call per symbol** (`range/1/day` returns the full series in one response), lease-paced at
5/min, wall-clock bounded, resumable across ticks, riding the existing `kairos-price-cache-fill`
schedule. Total cost: 11 requests. Note the fix order — the honesty guard is correct with **zero**
backfill and ships independently of it.

### India parity

India has **no equivalent defect**. `MarketsPage` gates the whole US analytics block behind
`{!isIndia && …}`; India renders its own `SectorHeatmap` from NSE sector indices, which is a
**single-session** snapshot with **no period selector** — so it cannot make a period claim its data
cannot support. Structural gaps already carry an explicit `NotSupportedNote`. Per-market and
per-currency; nothing is cross-summed. No change was needed and none was made.

## Files

- `app/api/agents/price-cache-fill/route.ts` — new fill job; + sector history backfill (2026-07-17)
- `lib/markets/sector-returns.ts` — span-aware honesty layer (pure; `tests/sector-returns-span.test.ts`)
- `app/api/charts/sector-returns/route.ts` — honesty guard + paginated read (2026-07-17)
- `components/charts/SectorPerformanceChart.tsx` — insufficient-history / partial-coverage states
- `components/dashboard/SectorBreadth.tsx` — per-clause scope labelling + reason instead of "—"
- `app/api/markets/synthesis/route.ts` — cache-first read + strong-majority cache gate
- `components/dashboard/MarketsPage.tsx` — `MacroReadCard` self-heal on stale
- `lib/schedule.ts` — display metadata entry
- `supabase/migrations/20260715140000_price_cache_fill_cron.sql` — pg_cron schedule
- `docs/arch/05-crons-and-scheduling.md` — cron chapter entry
