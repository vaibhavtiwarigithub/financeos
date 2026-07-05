# Codex / ChatGPT Review — Kairos India Multi-Market (2026-07-05)

**Instructions for Vaibhav:** Open this in Codex (Chrome extension, with the repo + the app running on `http://localhost:3000`) or paste into ChatGPT with the repo attached. Let it produce the findings report, then save the report where Claude Code can read it (e.g. `CODEX_REVIEW_RESULT.md` in the repo root) and tell Claude "read it, fix all".

---

## WHAT TO REVIEW

I just shipped a large **US + India multi-market** capability across ~6 commits (`5e10fb2` → `6cacc7c`). Review it for **correctness bugs, data-integrity issues, and resilience holes** — NOT style. This is a real-money-adjacent trading app; a wrong-currency number or a mis-scoped exit is a serious bug.

Be direct, skip praise. Output a **prioritized findings list** (see format at the bottom) so I can fix them mechanically.

## THE CORE DESIGN (so you can judge correctness against intent)

- **Market is a tag, never a fork.** Every paper pool / position / trade / signal / score-history / champion row carries `market` (`us`|`india`). One app; a global switcher (`lib/market-context.tsx`, `useMarket()` + `mkt` cookie) scopes panels.
- **Currencies are NEVER summed.** US pool = USD ($10k), India pool = INR (₹1,000,000). Two `paper_portfolio` rows. `paper_performance` unique key is `(date, market)`.
- **Per-market champion weights** (`strategy_versions.market`); LearnerAgent analyzes ONE market's cohort per run so India can't shift US weights.
- **Guarded/resilient:** all code must behave byte-for-byte as the old US-only app when the `market` column/India pool is absent (pre-migration). Pattern: `market ?? "us"`, resilient `.eq("market",…)` with unscoped fallback.
- **Data sources:** India data = free Yahoo `.NS` (`lib/india-data.ts`); India execution = Zerodha Kite (`lib/kite.ts`); full-universe + insider + options = direct NSE JSON (`lib/nse-data.ts`, fails soft, may geo-block). US unchanged (AV/FD/Massive/Robinhood).
- **Migrations:** `057_multi_market.sql` (applied), `058_india_screen_cache.sql` (applied).

## HIGH-VALUE AREAS TO SCRUTINIZE

1. **Currency correctness** — anywhere a `$`+`₹` could get summed, or a ₹ value shown with a `$`. Especially NAV, risk metrics, portfolio totals, briefing, kill-switches (kill-switch reading ₹1M NAV against USD drawdown thresholds = dangerous).
2. **`paper_portfolio` reads** — post-057 there are 2 rows. Any `.single()` (throws on >1 row) or unscoped `.limit(1)` (grabs arbitrary pool → wrong currency) on a US-facing read. Files: `lib/kill-switches.ts`, `lib/brokers/index.ts`, `app/api/agents/{trader,trade,performance}`, `app/api/briefing/generate`, `app/dashboard/{page,portfolio,trading,agents}`.
3. **PaperTrader** (`app/api/agents/paper-trade/route.ts`) — does each signal fill into the RIGHT pool, size off THAT pool's cash, price from the right source (US getQuote / India Yahoo)? Does `?market=` scoping + the `activeMarkets` filter behave when India pool is absent?
4. **PositionMonitor** (`app/api/agents/position-monitor/route.ts`) — India positions priced via Yahoo not Massive? Exits credit the correct pool? Per-market NAV recompute correct? `?market=` scoping?
5. **LearnerAgent** (`app/api/agents/learner/route.ts`) — is the cohort/champion truly market-scoped (`scopeMkt`)? Could India outcomes leak into US correlation/phase-gate/challenger?
6. **ResearchAgent** (`lib/research-agent.ts`) — market-matched champion read; `market` tag on `agent_signals` + `signal_score_history` inserts; resilient retry if column missing.
7. **Cron scoping** (`app/api/agents/research/cron/route.ts`, `scripts/run-agents.ps1`, `scripts/register-tasks.ps1`) — US `?market=us` + India `?market=india`; India tasks at ET times post-NSE-close (5:30/6:15/6:35 AM). Any double-processing? Weekend/holiday gating correct per market?
8. **India adapters** — `lib/india-data.ts` (Yahoo crumb, indices, sectors, earnings), `lib/nse-data.ts` (cookie handshake, equity list, insider, option chain, earnings). Do they truly fail soft (never throw / never 500 a route)? Do all callers fall back cleanly?
9. **Scanner cache** (`app/api/scan/india/refresh/route.ts`, `app/api/scan/india/route.ts`) — does the cache read fall back to live NIFTY-100 on missing table / empty cache without 500? Batch rate-limiting sane?
10. **Global switcher / support registry** — `lib/market-context.tsx` (localStorage/cookie sync, India-disabled guard), `lib/market-support.ts` (longest-prefix match correct?), the DashboardShell footer.
11. **Risk beta** (`lib/portfolio-risk.ts`) — `computeRiskMetrics` is now async; all callers `await`? India beta math (cov/var, weight renormalization) sound?

## KNOWN/ACCEPTED (don't report these)

- NSE feeds may geo-block a US IP → graceful fallback to Yahoo/NIFTY-100 with a visible note. Known.
- India-only US-only remnants: Markets TradingView/macro-sentinel tiles, Strategies Algo Library. Intentional.
- Kite daily token requires manual one-click login (SEBI). Intentional.
- India isn't paper-traded until `market_focus` includes India. Intentional.

## OUTPUT FORMAT

Give a ranked list, most severe first:

```
[SEV: critical|high|medium|low] path/to/file.ts:LINE
Problem: <one sentence — the concrete defect>
Trigger: <inputs/state that hit it>
Fix: <specific change>
```

End with a one-line count by severity. Focus on real defects that would produce wrong numbers, crashes, silent no-ops, currency mixing, or cross-market contamination.
