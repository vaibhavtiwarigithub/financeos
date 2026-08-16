# Incident + Proposal: Evaluation Pipeline Silent Failure

**Status:** DRAFT — awaiting adversarial review, then owner approval
**Author:** Claude (Architect role, per AGENTS.md)
**Date:** 2026-08-16
**Reviewer requested:** Codex — instructed to challenge every claim below

---

## 0. Why this document exists

The label-maturation pipeline produced **zero output for 25 days**. Every
monitoring layer reported success the entire time. It was found only by a
~40-step manual investigation starting from an unrelated question about paper
portfolio P&L.

Two deliverables are needed:
1. A correct fix for the failure.
2. A change that makes this **class** of failure loud, because the money path
   and the evaluation path are the two most critical paths in the app.

Everything below is evidence-backed. Where I could not verify something, it is
marked **UNVERIFIED**. Three of my own hypotheses were refuted mid-investigation
and are recorded in §4 so the reviewer can check whether I stopped too early.

---

## 1. Observed symptom

Production query, 2026-08-16:

| Market | Observations | Old enough for h5 labels | Actually labeled | Backlog |
|---|---|---|---|---|
| US | 3,473 | 2,274 | 536 | **1,738 (76%)** |
| India | 932 | 599 | 151 | **448 (75%)** |

Labeled observation range: **2026-07-06 → 2026-07-22** in both markets.
Observations still arriving normally through 2026-08-15/16.
**Zero labels for any observation dated ≥ 2026-07-23.**

Live invocation of the job via its own vault-backed path
(`select kairos_call_agent('/api/agents/label-maturation','{}'::jsonb,'POST',310000)`)
returned:

```json
{"success":true,"matured":0,"skipped":800,"atrLabeled":0,"atrUnavailable":0,"market":"all"}
```

800 = 200 rows × 4 horizons (2/5/10/20). **100% skip rate. Deterministic, not intermittent.**

---

## 2. Root cause chain (as diagnosed)

### 2.1 Upstream: `price_cache` is frozen for most symbols

```sql
WITH s AS (SELECT symbol, count(*) rows, max(date) newest FROM price_cache GROUP BY symbol)
SELECT ... FROM s GROUP BY freshness;
```

| Freshness | Symbols | Avg rows |
|---|---|---|
| **FROZEN at 2026-07-22** | **101** | **252** |
| current (≥ Aug 10) | 31 | 159 |
| frozen May 2026 | 6 | 200 |

252 rows = exactly one trading year. Signature of a **one-time 1-year backfill**
that ran ~2026-07-22 and was never refreshed. Only 31 symbols still advance.

`price_cache` overall `max(date)` is 2026-08-13 and `max(cached_at)` is
2026-08-14 — so aggregate freshness checks on the table look healthy while 72%
of symbols are 25 days stale.

### 2.2 The trap: stale cache is accepted as sufficient

`app/api/agents/label-maturation/route.ts:33-59`:

```typescript
async function usCandles(supabase, symbol, sinceDate) {
  const { data } = await supabase.from("price_cache")
    .select("date, close, high, low").eq("symbol", symbol)
    .gte("date", sinceDate).order("date", { ascending: true });
  const cached = (data ?? []).map(...);
  if (cached.length > 0) return cached;          // <-- LINE 43

  // Provider fallback that exists precisely for this case:
  const resolved = await fetchUsCandles(symbol, async () => [], 3);
  ...upserts into price_cache...
}
```

`sinceDate = decisionDate − 5 days`. For a Jul 17–22 decision, the frozen cache
*does* contain rows in that window, so `cached.length > 0` is true and the
function returns a slice that ends at Jul 22. **The provider fallback on line 48
is unreachable whenever the cache is stale-but-present**, so coverage can never
self-heal.

### 2.3 The skip

`route.ts:148-149`:

```typescript
const afterEntry = onOrAfter.filter(c => c.date > onOrAfter[0].date);
if (afterEntry.length < horizonDays) { skipped++; return; }
```

Measured on the actual pending queue (oldest 200, h2):

| | US | India |
|---|---|---|
| Pending observations | 199 | 1 |
| Distinct symbols | 68 | 1 |
| Decision dates | Jul 17–22 | Jul 13 |
| **Zero cached rows after decision date** | **135 of 199** | 1 of 1 |
| Avg forward rows available | **0.3** | 0.0 |

Even h2 needs 2 forward candles. Average available is 0.3.

### 2.4 Head-of-line starvation

`route.ts:79-104` — `loadPendingObservations` orders `ts ASC` and returns
`pending.slice(0, 200)`. The same permanently-failing oldest rows consume the
entire per-horizon budget every run, so newer observations are never reached.

The comment at line 80 shows this was already patched once for *labeled* rows
("can permanently starve newer labels"). The identical trap remains open for
*unfetchable* rows.

### 2.5 Why nothing alerted

| Layer | Reported during total failure |
|---|---|
| pg_cron `job_run_details` | `succeeded` (means the SQL statement ran) |
| `net._http_response` | `200` |
| Response body | `"success": true` |
| `agent_runs` | `status='done'`, 6 runs in 7 days |
| `stale-check` cron | green — asks *did it run*, never *did it produce* |

10 unresolved rows in `agent_alerts` right now: sentiment availability, insider
sparsity, EODHD/AV budgets, Kite session expiry, screener budget deferral.
**Every existing alert monitors an INPUT. None monitors an OUTPUT.**

`{"success":true,"matured":0,"skipped":800}` is indistinguishable from health at
every layer in the system.

---

## 3. Blast radius

### 3.1 Money path — believed NOT corrupted

`lib/data/quotes.ts` `getQuote` priority: **Massive live snapshot → price_cache → AV**.
`fetchCachedQuote` derives staleness from the bar's market date, not `cached_at`:

```typescript
const retrievedAt = data.date + "T20:00:00Z";
stale: isStale(retrievedAt),
```

A Jul 22 bar is correctly flagged `stale: true` rather than presented as live.
Trading/exits are not silently reading 25-day-old prices.

**CHALLENGE THIS.** Reviewer should verify every money-path consumer of
`price_cache` (`lib/portfolio/inputs.ts`, `lib/data/benchmark-series.ts`,
position-monitor, paper-trade) actually respects the `stale` flag rather than
reading `price` and ignoring provenance. I checked `quotes.ts` only.

### 3.2 Evaluation path — confirmed broken

label-maturation reads `price_cache` **directly**, bypassing the `getQuote`
staleness guard entirely. Everything downstream runs on two stale weeks:
dimension diagnostics, plan calibration, the MAE/MFE risk-parameter path,
LearnerAgent, and the walk-forward-IC-folds promotion work.

### 3.3 Consequence for performance analysis

The only labeled window (Jul 6–22) contains a selloff (date-level
benchmark-neutral: Jul 6 −3.06%, Jul 9 −3.98%, Jul 10 −3.79%, recovering to
+1.36% by Jul 19–20). VOO's +3.04% 1-month rally is **entirely unlabeled**.

This caused a real analytical error during the investigation: an initial reading
of "US selection has −1.83% alpha" was wrong. Splitting by the entry gate:

| | h5 bench-neutral | avg score | n |
|---|---|---|---|
| US eligible | **−0.34%** | 82 | 139 |
| US rejected | −2.88% | 54 | 199 |
| India eligible | **+0.88%** | 77 | 80 |
| India rejected | +0.32% | 63 | 54 |

The entry gate is capturing 2.54pp in US. The aggregate was dominated by
candidates the system correctly refused to buy.

---

## 4. Hypotheses I raised and then REFUTED

Recorded so the reviewer can check whether the final diagnosis is also premature.

| # | Hypothesis | How it died |
|---|---|---|
| 1 | label-maturation only runs on a Windows Scheduled Task | `cron.job` shows `kairos-label-maturation` jobid 38, `0 22 * * 1-5`, **active**. Only `db-backup` is Windows-scheduled |
| 2 | Vercel Hobby clamps `maxDuration=300`, truncating the job | Vercel docs (updated 2026-07-01, Fluid compute): Hobby default **and** max are both **300s**. No clamping. The `// Needs Vercel Pro` comment in the route is stale |
| 3 | `price_at_decision` being non-NULL breaks labeling | 35 India + 6 US rows with non-null price on Jul 21–22 labeled successfully. Correlation was temporal, not causal |
| 4 | Cache coverage is *thin* (few rows) | Cache is not thin — exactly 252 rows/symbol. It is **stale**. My original proposed fix targeted the wrong property |

Hypothesis 4 is the important one: I nearly shipped a "require N rows" fix that
would have passed a 252-row frozen cache.

---

## 5. Proposed solution (THE THING TO CHALLENGE)

### Layer 1 — Correctness

`usCandles` must require that cached rows **cover the required forward window**,
not merely exist. Thread `horizonDays` (or a required end-date) through
`getCandles`/`candlesFor`; if coverage is insufficient, fall through to
`fetchUsCandles`, which already upserts what it fetches — making the cache
self-healing and immunising the labeler against upstream freezes.

**Prerequisite, must be done empirically before writing code:** confirm
`fetchUsCandles('AAPL', async () => [], 3)` actually returns bars past 2026-07-22.
If the provider path is also broken, Layer 1 changes nothing. **UNVERIFIED.**

### Layer 2 — Head-of-line starvation

Stop permanently-failing rows from monopolising the budget. Proposed: a
`label_attempts` counter on `decision_observations`, incremented on skip, with
rows above a threshold excluded from the `ts ASC` ordering (and surfaced as a
data-quality alert rather than silently dropped).

Requires a migration → must be verified applied to production before the
dependent code ships, per the standing schema rule.

### Layer 3 — Make this class of failure loud (the point of the exercise)

Both items extend existing machinery (`reportIssue`/`resolveIssue`,
`agent_alerts` with `issue_key` dedup, the `stale-check` route). No new system.

**3a. Productive-run assertion.** A shared helper:

```typescript
assertProductiveRun({ agent, market, attempted, produced })
// raises a `critical` alert when attempted > 0 && produced === 0
```

For label-maturation this is `pending > 0 && matured === 0` — it would have
fired on **day one, 25 days ago**. Apply to the critical-path jobs:
label-maturation, research, paper-trade, position-monitor, price-cache-fill,
edge-scout.

**3b. Freshness contracts.** Extend `stale-check` from liveness to output.
Assert that critical tables *advance*:
- `price_cache` — per-symbol staleness, not just `max(date)` (the aggregate
  looked healthy at Aug 13 while 101 symbols sat at Jul 22)
- `observation_labels.max(ts)` tracking `decision_observations.max(ts)` within
  the horizon window
- `benchmark_scorecard.as_of` current

**Sequencing recommendation:** Layer 3 **first**, before the repairs — so the
fixes are verified by the system rather than by another 40-query manual audit.

---

## 6. Explicit challenges for the reviewer

Attack all of these. Disagreement with reasoning is more valuable than agreement.

1. **Is the root cause right?** Is the `price_cache` freeze causal, or is it a
   second symptom of a shared upstream cause (e.g. `price-cache-fill` covering
   only 31 symbols by design, or a provider entitlement change on ~2026-07-22)?
2. **Is Layer 1 the correct fix**, or should label-maturation stop reading
   `price_cache` altogether and always use the provider path with its own cache
   discipline? Argue the trade-off against provider quota.
3. **Why did `price-cache-fill` stop covering 101 symbols on 2026-07-22?**
   I did not determine this. It may be the true root cause and my Layer 1 may be
   treating a symptom for the second time.
4. **Money path verification (§3.1).** I checked `quotes.ts` only. Do
   `lib/portfolio/inputs.ts`, `lib/data/benchmark-series.ts`, position-monitor
   and paper-trade respect the `stale` flag, or do they read `price` directly?
5. **Is `assertProductiveRun` the right abstraction?** Zero-output is legitimate
   for some jobs on some days (weekends, empty queues). How should the contract
   distinguish "nothing to do" from "failed to do everything"? Note existing
   responses like `{"skipped":true,"reason":"weekend + shallow backlog","backlog":0}`.
6. **Is there a cheaper, more general mechanism** than per-job assertions —
   e.g. a single declarative table of output contracts (`table`, `expected
   advance`, `grace`) checked by one cron? Argue for or against.
7. **What else has this shape?** Search for other jobs that can return
   `success: true` while producing nothing. `position_monitor` recorded 2
   `status='error'` runs on 2026-08-14 that I did not investigate.
8. **Is `label_attempts` (Layer 2) over-engineering?** Would a simpler ordering
   change (e.g. split the budget between oldest and newest) fix starvation with
   no migration?

---

## 6b. ADDENDUM (2026-08-16, after §6 was written) — VERIFY OR REFUTE THESE

Findings made after the challenge list. They are stated as claims **to be
attacked**, not as settled conclusions. If any is wrong the proposal changes.

### CLAIM A — Challenge #3 is answered: the cache is SELF-POISONING

`price-cache-fill` operates on a **fixed** universe
(`app/api/agents/price-cache-fill/route.ts:38`):

```typescript
const UNIVERSE = Array.from(new Set([...REGIME, ...SECTORS, ...LEVERAGED]));
```

The 31 "current" symbols in production are **exactly** that set — index ETFs,
sector SPDRs, leveraged/macro ETFs, zero single stocks:

```
DIA FAS FAZ GLD GLL HYG IEF IWM QQQ SOXL SOXS SPXL SPXS SPY SQQQ
TLT TQQQ UGL UUP VIXY XLB XLC XLE XLF XLI XLK XLP XLRE XLU XLV XLY
```

So `price-cache-fill` never covered research symbols **by design**. It is not
the culprit.

The 109 frozen research symbols (AAPL, AMD, ARM, ASML, AVGO…) were written by
**label-maturation's own fallback**, `route.ts:57`, which upserts whatever
`fetchUsCandles` returns — 1 year = **252 bars**.

Therefore:
1. Fallback fetches 1y for a research symbol, upserts 252 bars ending ~Jul 22
2. That write makes `cached.length > 0` permanently true for that symbol
3. Line 43 returns the frozen slice on every subsequent run
4. **The fallback disabled itself with its own write** — write-once-then-deadlock

This explains every observed number exactly: 252 rows (1y fetch), Jul 22 (last
successful fallback run), those specific symbols (research, not ETF), and why
the failure is permanent rather than intermittent.

**If CLAIM A holds, Layer 1 is the true root-cause fix, not a symptom fix** —
the defect is wholly contained in `usCandles`.

**Attack it:** is there another writer to `price_cache` for single stocks?
Does `fetchUsCandles(symbol, async () => [], 3)` actually return 252 bars, and
does it return bars past Jul 22 today? If that provider call is itself broken,
Layer 1 fixes nothing.

### CLAIM B — Money path is defended, with ONE real gap

`position-monitor/route.ts:123,128,139` rejects stale quotes at all three call
sites:

```typescript
if (q && q.source !== "unavailable" && !q.stale && q.price > 0) priceMap[sym] = q.price;
```

A stale quote never enters the price map, so it cannot drive a stop or exit.
`paper-trade` uses the guarded `getQuote`/`getBatchQuotes` path.

**The gap:** `lib/portfolio/inputs.ts:29` `estimateDailyVolPct` reads the last
21 `price_cache` closes with **no staleness check**, and is consumed by
`paper-trade/route.ts:9` for position sizing. For the 109 frozen symbols this
vol estimate is not merely stale but **permanently frozen** — it will return a
Jun–Jul 2026 dispersion forever until the cache is repaired.

Assessed severity: moderate, not critical — it is a dispersion estimate feeding
position **size**, not a price level feeding a stop/exit trigger, and it falls
back to `DEFAULT_DAILY_VOL`. **Attack this severity call.**

### CLAIM C — Benchmark numbers are NOT contaminated

`BENCHMARK_BY_MARKET.us = "SPY"` (`lib/data/benchmark-series.ts:27`) and SPY is
current (Aug 13, 268 rows). Separately `benchmark_scorecard` uses `VOO`, and
VOO **is** frozen in `price_cache` at Jul 24 (1,255 rows) — but `paper_performance.bench_nav`
advances daily through Aug 14 (714.95) because `paper-trade/route.ts:1040` calls
`getQuote`, which hits live Massive first and only falls back to `price_cache`.

So the reported US −2.98% vs VOO 1M figure is sound. **Attack this** — confirm
no scorecard path reads the frozen VOO rows directly.

### Unexamined, flagged for the reviewer

- `agent_runs` recorded 2 `position_monitor` rows with `status='error'` on
  2026-08-14. Never investigated. Money path.
- `paper_performance` shows identical `bench_nav` (708.42) on Aug 12 and Aug 13,
  with NAV moving 10,341.25 → 10,034.45 (−3.0%) in one day on a ~25%-cash book.
  Possibly a duplicated benchmark bar or a NAV bug. Unexplained.

---

## 7. Evidence appendix — reproduction queries

```sql
-- Backlog
SELECT o.market, count(DISTINCT o.id) AS observations,
       count(DISTINCT l.observation_id) AS with_any_label
FROM decision_observations o
LEFT JOIN observation_labels l ON l.observation_id = o.id
GROUP BY o.market;

-- price_cache freshness distribution (THE root-cause query)
WITH s AS (SELECT symbol, count(*) rows, max(date) newest FROM price_cache GROUP BY symbol)
SELECT CASE WHEN newest >= '2026-08-10' THEN 'current'
            WHEN newest = '2026-07-22' THEN 'FROZEN at Jul 22'
            ELSE 'other: ' || newest END AS freshness,
       count(*) symbols, round(avg(rows)) avg_rows
FROM s GROUP BY freshness ORDER BY symbols DESC;

-- Forward coverage for the actual pending queue
WITH pend AS (
  SELECT o.id, o.symbol, o.market, o.ts::date AS decision_date
  FROM decision_observations o
  LEFT JOIN (SELECT DISTINCT observation_id FROM observation_labels WHERE horizon_days=2) l
    ON l.observation_id=o.id
  WHERE l.observation_id IS NULL AND o.ts < now() - interval '10 days'
  ORDER BY o.ts ASC LIMIT 200
)
SELECT p.market, count(*) pending_obs, count(DISTINCT p.symbol) symbols,
       count(*) FILTER (WHERE coalesce(pc.n,0)=0) AS zero_forward_coverage,
       round(avg(coalesce(pc.n,0)),1) AS avg_forward_rows
FROM pend p
LEFT JOIN LATERAL (SELECT count(*) n FROM price_cache c
                   WHERE c.symbol=p.symbol AND c.date::date > p.decision_date) pc ON true
GROUP BY p.market;

-- Live job invocation (async; read net._http_response after)
SELECT kairos_call_agent('/api/agents/label-maturation', '{}'::jsonb, 'POST', 310000);
SELECT id, status_code, created, left(content,400) FROM net._http_response ORDER BY id DESC LIMIT 5;
```

Note: the local `.env.local` `CRON_SECRET` is **stale** — a direct curl with it
returns 401. Production uses the vault secret `kairos_cron_secret`; invoke via
`kairos_call_agent` instead.
