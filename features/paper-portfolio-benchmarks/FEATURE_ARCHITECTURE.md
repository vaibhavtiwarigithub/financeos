# Paper Portfolio — market-aware benchmarks + page cleanup

**Status: SHIPPED. 2026-07-08.**
- migration 130 (applied): `paper_performance.bench_nav`/`bench_return_pct`.
- paper-trade route computes VOO (US) / NIFTY `^NSEI` (India) into bench_* + alpha
  for BOTH markets (US also mirrors into legacy spy_* for back-compat).
- metrics route surfaces bench_return_pct (+ benchmarkLabel) so India gets a benchmark.
- PortfolioPage gauge is market-aware ("Alpha vs VOO"/"Alpha vs NIFTY") and reads the
  stored bench; BenchmarkChart plots the per-market bench line from bench_return_pct
  (dropped the hardcoded US VOO/QQQ fetch — fixed the US-index-on-India leak).
- LiveHoldingsTab is market-aware: US → Robinhood ($), India → Zerodha Kite (₹) via
  new owner-gated `/api/kite/holdings` (read-only). Fixes the Robinhood-on-India leak.
Last updated: 2026-07-08

## Why

The Paper Portfolio page has three real defects and one missing feature, all
surfaced from the live dashboard:

1. **Benchmark is inconsistent (US) and absent (India).**
   - US: the paper-trade route stores alpha vs **SPY** (`paper_performance.alpha_pct`,
     [app/api/agents/paper-trade/route.ts:639]), but the UI gauge independently
     fetches **VOO** and computes a *second, different* alpha labelled
     "Alpha vs VOO" ([components/dashboard/PortfolioPage.tsx:199,225,736]). Two
     benchmarks for one number.
   - India: the route explicitly skips benchmark computation (`if (market==="us")`),
     so India stores no benchmark at all — yet the UI still renders the hardcoded
     "Alpha vs VOO" needle on the India view (reads a meaningless ~+0.0%).
   - The Risk page footer already promises "US vs SPY, India vs NIFTY" — India
     has no NIFTY series wired, so the promise is unmet.

2. **US-broker text leaks onto the India view (bug).** `LiveHoldingsTab()` renders
   "Robinhood Live Positions" + "Robinhood Trading account ••••8641" unconditionally
   ([PortfolioPage.tsx:535,609]) — including when `activeMarket === "india"`, whose
   broker is Kite, not Robinhood. The trade-queue is already market-guarded at
   :733; LiveHoldings is not.

3. **No benchmark line on the return chart.** The "Portfolio vs Benchmark (% return)"
   chart currently plots only the portfolio return line; the benchmark it names is
   not drawn. User wants the benchmark drawn alongside portfolio gain/loss, for
   BOTH markets.

4. **General cleanup** of the page (redundant/again-fetched benchmark, dead labels).

Non-goal: this does not touch the fill engine, sizing, money limits, or live-order
paths. Read/display layer + one additive benchmark-series write for India.

## Proposed design

### A. One benchmark per market, computed server-side (single source of truth)
- **US benchmark = SPY** (already computed and stored in `paper_performance`).
  Retire the client-side VOO fetch + client-side alpha. The gauge and the chart
  both read the stored `spy_return_pct` / `alpha_pct`. Label becomes **"Alpha vs SPY"**.
  *(Decision point for you: keep SPY, or switch the stored benchmark to VOO?
  SPY is already wired end-to-end; recommendation: keep SPY, drop VOO.)*
- **India benchmark = NIFTY 50** (`^NSEI` via the existing India quote path —
  same Yahoo `.NS`/index source India NAV already uses). Add its close + return to
  the India `paper_performance` rows, mirroring the US SPY fields. This is the only
  data-layer change: the route's per-market perf block gains an India branch that
  fills `bench_nav`/`bench_return_pct`/`alpha_pct` from NIFTY instead of leaving them null.

  **Schema:** `paper_performance` currently has US-specific `spy_nav`/`spy_return_pct`.
  Two options:
  - **(A1, recommended) rename-free, additive:** add generic `bench_nav numeric`,
    `bench_return_pct numeric` columns (nullable). US writes SPY into them (and keeps
    spy_* for backward-compat), India writes NIFTY. UI reads the generic columns.
    One additive migration, verified applied before UI reads them.
  - (A2) reuse `spy_*` columns for both markets (semantically wrong name for India).
    Rejected — misleading column name.

### B. Market-aware UI (no cross-market leakage)
- Gauge label + benchmark name derived from `activeMarket`: **"Alpha vs SPY"** (US) /
  **"Alpha vs NIFTY"** (India). No hardcoded "VOO".
- `LiveHoldingsTab` (Robinhood) renders **only when `activeMarket === "us"`**. On
  India, either hide it or show a Kite-scoped equivalent (out of scope here — hide
  for now, matching the existing trade-queue guard pattern).

### C. Benchmark overlay on the return chart (both markets)
- "Portfolio vs Benchmark (% return)" plots two lines: portfolio cumulative %-return
  (existing) + benchmark cumulative %-return (**SPY** US / **NIFTY** India), both
  rebased to 0% at the window start, from `paper_performance` series. Legend + the
  headline number becomes portfolio − benchmark = alpha for that window.

### D. Cleanup
- Remove the client VOO fetch/compute path once the gauge/chart read server values.
- Delete the now-dead "Alpha vs VOO" hardcoded label.
- Keep the empty-state copy (US "No open positions…") — correct as-is; it will
  populate once the paper-fill fix (migrations 126–128) opens US positions.

## Data contract / touch list (for approval)
- **Migration (additive):** `paper_performance.bench_nav`, `bench_return_pct` (nullable).
  Verify applied via information_schema before UI reads them.
- **app/api/agents/paper-trade/route.ts** — per-market perf block: US fills bench_* from
  SPY (already fetched); add India branch filling bench_* from NIFTY (`^NSEI`).
- **components/dashboard/PortfolioPage.tsx** — market-aware label; read stored bench_*;
  drop client VOO fetch; guard `LiveHoldingsTab` to US; add benchmark line to the chart.
- **Docs:** SYSTEM_OVERVIEW.md (benchmark section) + system-map.json only if an
  agent-to-agent flow changes (it does not — display layer + one perf field).

## Locked decisions (2026-07-08)
1. **US benchmark = VOO.** Move the server-side benchmark computation from SPY to
   **VOO** in the paper-trade perf block; store into the new generic `bench_*`
   columns. Historical `spy_*` rows are left as-is (VOO≈SPY, both S&P 500); the
   new series is VOO forward. UI label = "Alpha vs VOO". Retire the client-side
   VOO fetch — the value now comes from the server like India's.
2. **India benchmark = NIFTY 50 (`^NSEI`)** via the existing India index source.
   Written into `bench_*` on India `paper_performance` rows. UI label = "Alpha vs NIFTY".
3. **India live tab = stub a Kite holdings tab.** Instead of hiding LiveHoldings on
   India, render a market-aware live-holdings tab: US → Robinhood block (existing);
   India → a **Kite holdings** block reading the India account's positions
   **read-only** (reuse the existing India live/holdings source the India Live page
   already uses — no new order path, no new broker-write surface). Guard: Robinhood
   block renders only for US, Kite block only for India — no cross-market leak either way.

### Revised touch list
- **Migration (additive):** `paper_performance.bench_nav`, `bench_return_pct` (nullable).
  Verify applied via information_schema before UI reads.
- **paper-trade/route.ts:** US perf block computes VOO (was SPY) into bench_*; new
  India branch computes NIFTY (`^NSEI`) into bench_*.
- **PortfolioPage.tsx:** market-aware label + benchmark line on the chart; drop client
  VOO fetch; `LiveHoldingsTab` becomes market-aware (Robinhood=US, Kite=India read-only).
- **Kite holdings read:** reuse the existing India live-holdings data source (same one
  the India Live + Signals page uses); read-only, no order/mutation path.
- **Docs:** SYSTEM_OVERVIEW.md benchmark section + "Last updated" bump. system-map.json
  only if a flow changes (it does not).

**Awaiting explicit approval to implement** (say "approved / implement / code it").
One caveat to confirm: switching US to VOO means the stored benchmark series changes
provider mid-history (SPY rows before, VOO after) — acceptable since both track the
S&P 500. Flag if you'd rather backfill VOO across history instead.
