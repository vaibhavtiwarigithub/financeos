# Feature Architecture — Asset-Class Allocation

> Status: **Deterministic CORE built + SHIPPED OFF (migration 175).** Genome
> evolution, the slow rebalancer, sizing wiring, and UI are the validated
> follow-up. Owner defaults chosen (below) — change any and say so.
> Last updated: 2026-07-13

## Built (2026-07-13, ships OFF)
- Migration 175: `strategy_sleeves(market, sleeve, target_pct, min_pct, max_pct,
  instruments, enabled)` seeded per market + `strategy_config.allocation_enabled`
  (default **false** → allocator inert; zero behaviour change today).
- `lib/allocation/allocator.ts`: deterministic `allocate(sleeves, regime)` — tilts
  targets by macro regime WITHIN hard bands, drops disabled sleeves, renormalizes
  to 100%. `computeAllocation(svc, market)` returns null unless enabled. NO LLM.
  Unit-tested (`tests/allocator.test.ts`).
- **Default decisions used** (owner-tunable in `strategy_sleeves`):
  - US: equity 70% (0–90), defensive_etf 20% (0–50, SHY/IEF/TLT/GLD), cash 10% (5–100), leveraged **OFF** (0–15).
  - India: equity 70%, defensive_etf 20% (LIQUIDBEES.NS/GOLDBEES.NS), cash 10%.
  - Leveraged sleeve **disabled**; rebalance cadence weekly / 5% deadband (documented; rebalancer not built yet).

## Follow-up (NOT built — money path + evolution)
1. Wire the equity-sleeve target into paper-trade sizing (only when enabled).
2. Slow rebalancer for defensive/cash sleeves (weekly cron, deadband).
3. Genome `allocation` block + LearnerAgent proposal + Validation gate.
4. Allocation UI (current vs target per sleeve).
Turn it on with `allocation_enabled=true` only after 1–3 land + are validated.

---

## Original proposal (retained)

> Status: **PROPOSAL — not built.** Needs owner approval before implementation.
> Last updated: 2026-07-13

## Problem

Today the book is **long-only single-name equities + a few ETFs** (metals basket,
region ETFs) with **cash** as the residual. There is **no allocation across asset
classes** — no bonds, no defensive/leveraged sleeves, no target weights, no
"hold more cash / bonds when the regime turns risk-off." Sizing is per-position
(Kelly / `position_size_pct`); the learner/genome evolves **scoring weights +
entry/exit/horizon/sizing**, NOT the asset mix. So the portfolio cannot shift its
*shape* to defend or press an edge as markets change — it only picks stocks.

The ask: can the agents figure out a balance across bonds / US ETF / cash /
stocks / leveraged ETF for max gain in any market, and keep evolving it?

## Design (proposed)

A thin **allocation layer ABOVE the existing stock picker** — it never replaces
scoring; it sets how much capital each sleeve gets, and the picker fills the
equity sleeve as it does now.

### 1. Sleeves (per market / currency — never cross-summed)
Define named sleeves with target bands, e.g. (US):
| Sleeve | Instruments | Band |
|---|---|---|
| `equity` | scored single names (current pipeline) | 0–80% |
| `defensive_etf` | bond/treasury ETFs (e.g. SHY/IEF/TLT), gold | 0–50% |
| `cash` | residual | 5–100% |
| `leveraged` | leveraged/inverse ETFs — **OFF by default, hard-capped, opt-in** | 0–15% |

India mirrors with its own instruments (liquid-bond ETFs, GOLDBEES, cash).

### 2. Deterministic allocator (no LLM on the money path)
A pure function `allocate(regime, riskProfile, genome) -> targetWeights` maps the
existing **`macro_regime`** signal + risk profile to sleeve targets within the
bands. Risk-off → more cash/defensive; risk-on → more equity. Deterministic,
auditable, bounded by the bands. (Consistent with the CLAUDE.md rule against
fragile explicit bull/bear *scoring* switches — this governs *allocation*, not
per-name scoring, and stays inside hard bands.)

### 3. Learner evolves the mapping (bounded, validated)
Extend the **genome** with an `allocation` block: the regime→sleeve-target
mapping + band edges. The LearnerAgent proposes challenger allocations; they go
through the **same champion/challenger + Validation Engine gate** (walk-forward,
fail-closed) before a human promotes. So it "figures it out and mutates" — but
only within hard bands, only via validated, owner-promoted challengers. Never
unbounded, never LLM-driven on the money path.

### 4. Execution
The trader/paper-trader sizes new entries against the **equity sleeve's** current
target, not the whole NAV; defensive/cash sleeves are held as ETF/cash positions
rebalanced on a slow cadence (e.g. weekly, with a no-churn deadband) to avoid
overtrading. Kill-switch / drawdown / per-market controls all still apply.

## Safety
- Leveraged sleeve OFF by default, hard-capped, explicit opt-in.
- All targets clamped to bands in code (not just config).
- Rebalance deadband to prevent churn.
- Paper-first; live only after the same gates as today.
- No cross-currency summing; each market allocates its own pool.

## Scope (build order, if approved)
1. Migration: `strategy_sleeves` (targets/bands per market) + genome `allocation` block.
2. `lib/allocation/allocator.ts` — deterministic `allocate()` + band clamp + tests.
3. Wire equity-sleeve sizing into paper-trade/trader.
4. Slow rebalancer for defensive/cash sleeves (cron, deadband).
5. Genome extension + LearnerAgent proposal + Validation gate + backtest.
6. UI: allocation panel (current vs target per sleeve); docs (arch-08/09 + system-map).

## Open questions for the owner
- Which bond/defensive instruments per market? (US: SHY/IEF/TLT/GLD? India: liquid-bond ETF + GOLDBEES?)
- Enable the leveraged sleeve at all, or leave it off?
- Rebalance cadence + deadband tolerance.
- Paper-only first (recommended) before any live allocation.
