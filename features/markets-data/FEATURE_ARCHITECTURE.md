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
- **`charts/sector-returns`** already reads `price_cache`; the daily fill keeps it warm and the
  cache accumulates history over successive fills. Its own lazy backfill remains as a cold-start
  safety net.
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

## Files

- `app/api/agents/price-cache-fill/route.ts` — new fill job
- `app/api/markets/synthesis/route.ts` — cache-first read + strong-majority cache gate
- `components/dashboard/MarketsPage.tsx` — `MacroReadCard` self-heal on stale
- `lib/schedule.ts` — display metadata entry
- `supabase/migrations/20260715140000_price_cache_fill_cron.sql` — pg_cron schedule
- `docs/arch/05-crons-and-scheduling.md` — cron chapter entry
