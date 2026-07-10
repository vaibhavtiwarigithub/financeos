# Trade Behavior Mirror — Past-Trade Analysis — Feature Architecture

> **STATUS: DRAFT — NOT APPROVED.** Proposal for review. No code until explicit sign-off.
> Owner decision pending. Created 2026-07-10.

## 1. Intent (owner's ask, restated)

Import all past Robinhood transactions. For each historical buy/sell, reconstruct the
**fundamental + technical values *at the time* of the trade**, compare to those same stocks
**now**, and have the Mentor characterize the owner's **behavioral / mental pattern** — do you buy
strength or dips, sell winners too early, average down on losers, panic in drawdowns — grounded in
the actual indicator values at each entry/exit, not vibes.

## 2. What already exists (partial build)

- **Import**: Robinhood CSV → `trade_decisions` (symbol, action, qty, exec_price, exec_date).
  `app/api/live-portfolio/import-csv/route.ts`.
- **Enrich**: per trade → macro regime at trade date, **forward** price 1d/1w/1m/3m, `outcome_score`
  (was the buy/sell right), `pattern_tags` (win/loss/breakeven + regime).
  `app/api/live-portfolio/enrich/route.ts`.
- **Mentor** reads `trade_decisions` (thesis/evaluate/ask) — comments on outcomes.
- Trades embedded into RAG (`trade_memories`, migrations 043/045).

## 3. The gap (the core of the ask — NOT built)

- ❌ **Point-in-time fundamental + technical values at each trade.** Enrich pulls forward *price*
  only — never "RSI/P-E/ROE/sentiment when you bought." So it cannot say *"you bought when RSI was
  82 and P/E was 60."*
- ❌ **Then-vs-now comparison** per stock.
- ❌ **Behavioral fingerprint synthesis** — the mental-pattern mirror itself.

## 4. Why it's non-trivial

- **Technical PIT** (RSI/EMA/RS/52w-distance at exec_date): CHEAP — computable from the daily
  series enrich already fetches (`TIME_SERIES_DAILY_ADJUSTED`). No new data cost.
- **Fundamental PIT** (P/E in 2021): NOT free — AV OVERVIEW is a *current* snapshot only. Must
  reconstruct: historical price × historical EPS from **FinancialDatasets historical income
  statements** (MCP available). Higher cost, per-symbol historical fetch.

## 5. Proposed design — 3 layers

**Layer A — Technical PIT fingerprint (cheap, high value).**
For each `trade_decisions` row, compute at `exec_date` from the daily series: RSI(14), EMA20/50
position, 20d trend, relative strength vs SPY/^NSEI, 52w-high distance, volume state. Store on the
row (new columns, additive migration). Also snapshot each symbol's values **now** → then-vs-now
delta. Reuses `computeTechnicals` (`lib/data/technicals.ts`) fed a PIT-sliced series.

**Layer B — Fundamental PIT.**
For each trade, fetch historical income statement / EPS at/around `exec_date` from FinancialDatasets;
derive P/E (exec_price × shares / historical earnings), margin, growth. Store PIT + now. Day-cached
+ budget-guarded. Degrades gracefully when history is missing (Layer A still stands alone).

**Layer C — Mentor behavioral fingerprint.**
A deterministic pass clusters entries/exits by their PIT signatures and computes behavioral metrics:
entry-RSI distribution (chase vs dip), win-hold vs loss-hold duration (cut winners early?),
add-to-loser rate (averaging down), drawdown-exit timing (panic sells), regime performance. The
Mentor LLM then *narrates* these deterministic findings (never invents the numbers) →
`mentor_insights`. This is the mirror.

## 6. Data model (additive, draft)

`trade_decisions` new columns (nullable, backfilled by re-enrich):
`rsi_at_trade, ema20_pos_at_trade, ema50_pos_at_trade, rs_vs_bench_at_trade, dist_52w_high_at_trade,
pe_at_trade, roe_at_trade, rev_growth_at_trade, tech_now_json, fund_now_json, fingerprint_json`.

New: `behavior_fingerprint` (one row per re-analysis run: entry-style, exit-discipline, averaging,
regime-skew metrics + Mentor narrative).

## 7. Guardrails

- Owner-only (all `live-portfolio/*` already `requireOwner`).
- Read/analysis only — never places or alters live/paper orders.
- PIT reconstruction must not leak future data into the "at-trade" snapshot.
- Mentor narrates deterministic metrics; it does not fabricate indicator values.
- FinancialDatasets fetches go through the day-cache + budget guard.

## 8. Phasing

- **P0** — Layer A (technical PIT + then-vs-now). Additive migration; re-enrich backfills.
- **P1** — Layer C on Layer-A signatures (behavioral fingerprint + Mentor narration).
- **P2** — Layer B (fundamental PIT) once A+C prove useful.

## 9. Open questions for review

1. Start with Layer A only (cheap, fast) or commit to A+B+C up front?
2. Benchmark for at-trade relative strength: SPY only, or SPY + sector?
3. How far back does the Robinhood history go (bounds the FinancialDatasets historical cost)?
4. Behavioral metrics to prioritize — which patterns matter most to you to see first?
