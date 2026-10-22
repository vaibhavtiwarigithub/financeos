# Research Universe Fix — Feature Architecture

## Owner-requested quantum/robotics ETF correction — 2026-10-21

Research-enable QTUM, BOTZ and ARKQ and add ROBO/ROBT to the owner's US manual
watchlist, with no expiration. Verify US listings against the issuer's own fund
page. These are research candidates, not five orders or five new position slots.
Complete canonical ETF membership before activation so company-only fundamental
ratios and insider data cannot masquerade as applicable dimensions. Existing ETF
weights, score cap, availability handling, duplicate-exposure/risk construction,
broker eligibility, cash limits and live controls remain unchanged.

An enabled symbol must have a path to research, not just a true watchlist flag.
The manual US pool exceeds its reserved cap; fixed newest-created-first ordering
can starve old entries (QTUM/BOTZ/ARKQ were created in June and never researched).
Reuse the existing internal score-history reader and staleness ordering for this
manual pool: never-researched first, then oldest researched. Holdings and the
leveraged priority remain first, manual names still precede carry-forward and
machine watchlists, and discovery retains its reserved slots. No new service,
cron, source, package, budget or cap exemption. Missing score history falls back
to the existing input order and existing diagnostics; no historical score is
manufactured. Confirm deterministic ordering/caps and ETF applicability in tests,
then verify the deployed owner watchlist and a bounded five-symbol research pass.

Issuer references: https://www.defianceetfs.com/qtum/ ;
https://www.globalxetfs.com/funds/botz/ ; https://www.ark-funds.com/funds/arkq ;
https://www.roboglobaletfs.com/robo ;
https://www.ftportfolios.com/Retail/Etf/EtfSummary.aspx?Ticker=ROBT .
Global fund holdings do not imply all foreign constituents are US-tradeable;
automatic full constituent admission is outside this bounded correction.

**Status:** APPROVED → IMPLEMENTING  
**Date:** 2026-07-09  
**Author:** Claude / Opus 4.8

---

## Problem

US paper fills = 0 individual stocks. Root cause confirmed (see `P0_BUILD_RESULT.md` in edge-factor-discovery):

`gatherSymbols()` in `lib/research-agent.ts` inserts all symbols into a single `Map`, with holdings first. `slice(0, RESEARCH_MAX_SYMBOLS=10)` takes the first 10 = exactly the 10 Robinhood ETF holdings (DXJ, FEZ, GLD, IBIT, IVV, SGOV, SPMO, VONG, VTV, XAR). Watchlist stocks appear at positions 11+; screener stocks at positions 11-13. All silently evicted by the cap. Metals and region ETFs survive only because they're appended after the cap, not before.

Evidence: 4 days of `agent_signals` decompose exactly as 10 holdings + 3 metals + 3 region ETFs = 16. Zero individual stocks ever enter the research batch, so zero individual stocks ever get signals, so fills stay 0.

---

## Root Cause (single line)

```
const nonMetals = Array.from(result.values()).slice(0, cap);  // cap=10 = all holdings
```

Holdings fill the entire cap before watchlist or screener stocks even enter the slice.

---

## Fix

**Separate the holdings-monitor budget from the new-buy candidate budget.**

Holdings are already owned. They need to be scored always (SELL signals, exit timing, position monitor). They should NEVER compete with or consume the budget for new-buy candidates.

New-buy candidates (watchlist stocks from Theme Scout + manual adds + screener stocks) need their own budget cap.

### Changed invariants

| Before | After |
|---|---|
| One shared cap (`RESEARCH_MAX_SYMBOLS=10`) applies to holdings+watchlist+screener together | Holdings uncapped (always all). Candidates use separate `RESEARCH_CANDIDATE_CAP` |
| Watchlist/screener stocks evicted when holdings fill cap | Watchlist stocks first, then screener stocks, up to `RESEARCH_CANDIDATE_CAP` |
| Screener max 3 stocks | Screener max `RESEARCH_SCREENER_MAX` (default 6) |

### Preserved invariants (no changes)

- `isHeld: true` on holdings → LLM prompt includes `heldNote` → SELL signals possible
- `isHeld: false` on new candidates → long-only new-position enforcement in PaperTrader
- Metals basket appended after cap (unchanged)
- Region ETFs appended after cap (unchanged)
- India holdings/candidates handled independently (unchanged)
- No schema changes, no migrations

---

## Code Changes

**One file: `lib/research-agent.ts`**

Replace the `result = new Map()` block (lines ~419-440) with two separate structures:

```
holdingEntries[]    — uncapped, always all holdings
candidateMap        — watchlist first, then screener, capped at RESEARCH_CANDIDATE_CAP
nonMetals           — [...holdingEntries, ...candidateMap.slice(0, candidateCap)]
```

### Environment variables

| Var | Old | New default | Notes |
|---|---|---|---|
| `RESEARCH_MAX_SYMBOLS` | 10 | deprecated | No longer read; remove from Vercel env to clean up |
| `RESEARCH_CANDIDATE_CAP` | — | 10 | Max new-buy candidates (watchlist+screener) per run |
| `RESEARCH_SCREENER_MAX` | — | 6 | Max screener-sourced stocks in candidates (raised from 3) |

### Expected batch after fix (US)

- Holdings: 10 ETFs (always)
- Candidates: up to 10 (watchlist stocks first, then screener fill up to 6 of the 10 slots)
- Metals: 4 (unchanged)
- India region ETFs: 3 (unchanged)
- **Total: ~27 max** (vs. 16 previously, which were 100% ETFs)

---

## Safety Analysis

- Holdings still scored → SELL signals preserved
- `isHeld` flag correct per entry → PaperTrader long-only gate unaffected
- No change to scoring logic, sizing, order path, live trading
- No DB schema change
- No migration
- Additive: batch gets larger (more API calls), but within existing rate limits and budgets

---

## Second Potential Blocker (to verify post-deploy)

`runScreener()` calls FinancialDatasets `screen_stocks`. FD key confirmed in vault. But screener output needs to be non-empty for any candidate stocks to appear. After fixing the cap eviction, verify via `agent_signals` that symbols with `source='screener_momentum'` or `source='screener_value'` appear. If screener returns 0 results, that's a separate issue (screener API health check needed).

---

## Diagram update

System Map and SYSTEM_OVERVIEW do not need updating for this fix — the agent-to-agent flow is unchanged; only the internal symbol prioritization within ResearchAgent changes.
