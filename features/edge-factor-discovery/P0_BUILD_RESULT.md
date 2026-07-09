# Edge/Factor Discovery — P0 Build Result

Date: 2026-07-08. Builder: Claude/Opus 4.8. Commit: `be06584`.
Scope: P0 ONLY (measure-only). P1 (IC gate), regime filter, and any change to
ResearchAgent/PaperTrader/TraderAgent were explicitly NOT built.

## What was built
- **Migration 132** (additive): `edge_catalog`, `edge_universe_members`,
  `edge_signals`, `edge_signal_inputs` (point-in-time input audit), `edge_ic_history`
  (placeholder for P1). RLS deny-by-default; service role bypasses.
- **`lib/edges/`**: `types.ts`, `data.ts` (bounded candle resolver reusing the
  existing cached+budgeted fetchers), `standardize.ts` (winsorize + cross-sectional
  z), `registry.ts` (8 price/volume edges), `compute.ts` (per-date cross-section,
  no look-ahead — candles sliced to ≤ asOf).
- **`app/api/agents/edge-scout/route.ts`**: owner-or-cron, measure-only, bounded
  (`maxSymbols` cap 100, `maxDays` cap 20), idempotent upserts, provider report.
- **`app/dashboard/edges/page.tsx`**: read-only Edge Catalog page + measure-only /
  survivorship honesty banner.

## Edges (price/volume only, no fundamentals)
12-1 momentum · relative strength vs benchmark · 50/200 DMA trend+slope ·
vol-adjusted momentum · short-term reversal-in-uptrend · 52-week-high proximity ·
volume breakout (only when the last 21 volumes are complete & positive) ·
low realized volatility (expected_sign −1).

## Verification

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Migration tables exist | ✅ | information_schema returned all 5 (`edge_catalog`, `edge_universe_members`, `edge_signals`, `edge_signal_inputs`, `edge_ic_history`) | Applied via MCP; verified before code reads them |
| Build + typecheck | ✅ | `npm run build` → 51/51 static pages, no type error; `/api/agents/edge-scout` + `/dashboard/edges` in route table | — |
| Additive-only migration | ✅ | 132 is `create table if not exists` only; no alter/drop on existing tables | — |
| Live run succeeded | ✅ | `POST /api/agents/edge-scout?market=us&maxSymbols=25` → HTTP 200, `{ok:true, measureOnly:true}` | be06584 deployed READY; fired via kairos_call_agent |
| Measure-only (no trading tables touched) | ✅ | Before run AND after 2 runs: agent_signals=**98→98**, paper_trades=**6→6**, paper_order_events=**11→11**, broker_orders=**2→2** | Route writes only `edge_*` |
| `edge_universe_members` written | ✅ | 25 rows, universe_id=`us:p0:2026-07-09`, source=`watchlist` | current-liquid snapshot, labeled |
| `edge_signals` written | ✅ | 154 rows across **8 distinct edges** (25 symbols; fewer than 8×25 because long-lookback edges skip short-history names) | — |
| `edge_signal_inputs` written | ✅ | 154 PIT-audit rows (input=`adjusted_close_candles`, source, as_of, available_at=next session) | — |
| Rerun is idempotent (no dup rows) | ✅ | 2 identical runs → totals stayed **154 / 154 / 25** (not 308) | unique-constraint upserts |
| Provider usage bounded + reported | ✅ | providerReport: 25/25 resolved, sources `{massive:9, eodhd:16}`, benchmark massive, 0 unavailable, dates `[2026-07-08]` | maxSymbols cap; cached/budgeted fetchers |

## Honesty / limitations (P0)
- **Universe is a CURRENT-liquid snapshot, NOT point-in-time index membership.**
  Recorded in `edge_universe_members` + labeled in the UI banner + the route
  response (`universeLimitation`). Any downstream backtest carries survivorship
  bias until PIT membership is wired (P1+).
- No IC yet — z-scores are not evidence of predictive power. P1 computes rolling
  IC/IR/t-stat/decay to answer "does any edge actually predict returns?".
- India fundamentals intentionally absent (P0 = price/volume only).

---

# P1 Build Result — IC gate (measure-only)

Date: 2026-07-08. Commits: `f2cc41a` (code). Still MEASURE-ONLY.

## What was built
- `lib/edges/ic.ts`: rank IC (Spearman) of edge value vs realized forward return by
  horizon (5/10/20d) on the broad historical candle universe; mean IC, IR, and a
  **Newey-West t-stat** correcting for overlapping-window autocorrelation; edges with
  expected_sign=−1 flipped so +IC always = "ranks winners above losers"; lifecycle
  classifier (`shadow_eligible` iff IC≥0.02 & |t|≥2, priored-factor hurdle; else
  `measure_only`; `benched_negative` on significant negative IC). Advisory only.
- `app/api/agents/edge-ic`: owner-or-cron, measure-only, bounded (maxSymbols/maxDates),
  idempotent upserts to `edge_ic_history`, advisory `edge_catalog.status` update.
- `/dashboard/edges`: IC Scorecard (IC + t per horizon + status per edge).

## Verification (live run: `edge-ic?market=us&maxSymbols=30&maxDates=50`)

| Item | Status | Evidence |
|---|---|---|
| `edge_ic_history` written | ✅ | 24 rows = 8 edges × 3 horizons |
| IC + Newey-West t computed | ✅ | e.g. mom_12_1 IC 0.10–0.13 (t 2.1–2.6); dma_trend_slope IC→0.23 (t 3.9) |
| Lifecycle classifier working | ✅ | 4 edges shadow_eligible, 3 measure_only, st_reversal benched_negative@20d |
| Measure-only (no trading tables touched) | ✅ | agent_signals 98, paper_trades 6, paper_order_events 11, broker_orders 2 — unchanged |
| Idempotent | ✅ | upsert on (edge_id,market,window_end,horizon); rerun stays 24 rows |

## Honest caveat (labeled in UI + response)
The verification universe was 30 tech-heavy watchlist names over ~50 recent sampled
dates with survivorship bias — so these ICs are **illustrative, not proof**. A broad
point-in-time universe over multiple years + regimes is required before any edge is
trusted. `net_of_fee_ic`/`turnover` left null (the cost-adjusted long-only bucket
alpha is the later P5 gate).

---

# Broaden IC evidence — result (measure-only)

Date: 2026-07-09. Commit: `9e56c63`. Purpose: make IC less noisy before P2 by
computing it on a broad cross-section instead of a 30-name watchlist.

## What was built
- `lib/edges/universe.ts`: static curated liquid universe (~110 US large/mid-caps
  across sectors, ~55 NSE). Labeled NON-PIT / survivorship-biased.
- resolver + edge-scout/edge-ic gain `universe=liquid`, `offset` (paging),
  `historyDays` (edge-ic defaults ~1000 cal days ≈ 2.5–3yr). Cap raised to 200.

## Run (bounded, cached)
1. Warm cache: 3× `edge-scout?universe=liquid&historyDays=1000&maxSymbols=40&offset=0/40/80`
   → 120 universe members, 680 signals, all done.
2. `edge-ic?universe=liquid&maxSymbols=200&historyDays=1000&maxDates=60` → 24 IC rows
   over the FULL 120-name cross-section.

## Finding (the payoff)
Broadening from 30 tech-heavy names to 120 diversified names **collapsed every
edge's IC to ≈0** and **nothing cleared shadow_eligible**:
- mom_12_1: 0.13 (t 2.6) → ≈0/slightly negative (t<1)
- dma_trend_slope: 0.23 (t 3.9) → 0.04–0.08 (t<1.7)
- rel_strength_6m: 0.21 (t 2.1) → 0.02 (t 0.4)
- low_realized_vol: negative IC (high-vol outperformed this window)
- st_reversal_uptrend: benched_negative @20d (consistent)

**Interpretation:** the strong 30-name signal was concentration + survivorship
artifact. The IC gate correctly REFUSED to promote an illusory edge — which is the
entire purpose of P1. Measure-only confirmed: agent_signals/paper_trades unchanged.

## Caveats (unchanged, honest)
One ~2.5yr window (a specific post-2023 regime), still survivorship-biased
(current-liquid names), no fees, no PIT membership. So this is "these price/volume
edges don't clear the bar ON THIS SAMPLE", NOT "momentum is dead." Real rigor needs
multi-year + point-in-time membership + cost-adjusted long-only bucket alpha (P5).

## Implication for the roadmap
P2 (shadow composite) is **not yet worth building** — with no edge clearing the IC
bar on the broad sample, there is nothing trustworthy to blend. The higher-value
next step is data rigor: true PIT membership + a longer, multi-regime window, then
re-measure. (Owner decision.)

## Not done (by design)
P2 shadow composite; P3 exploratory paper; P4 regime scaler; P5 active paper; P6 live;
any wiring into analyst_score / paper fills / sizing / live orders; scheduled crons
(edge-scout + edge-ic stay owner-triggered until they prove out).
