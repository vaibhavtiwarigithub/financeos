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

## Not done (by design)
P1 IC gate; regime filter; composite score; any wiring into analyst_score / paper
fills / sizing / live orders; a scheduled `kairos-edge-scout` cron (P0 is
owner-triggered until it proves out).
