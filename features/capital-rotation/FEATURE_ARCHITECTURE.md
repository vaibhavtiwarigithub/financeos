# Feature Architecture — Capital Rotation (opportunity-cost reallocation)

> Status: **PROPOSAL — architecture only, not built.** Needs owner sign-off.
> Scope: deterministic; touches the money path (sell-to-fund) → Phase 1 PAPER-only, Phase 2 LIVE behind approval + all gates.
> Last updated: 2026-07-13
> Update when built: `docs/arch/03-agents.md`, `docs/arch/08-risk-and-safety.md`, `docs/arch/09-learning-loop.md`, `public/agent-diagrams/system-map.json`.

## Problem
When the book is fully invested and a materially better candidate appears, the system **passes it over** — PaperTrader/Trader rejects the buy with `insufficient_cash`. Sells only happen on **absolute** exit rules (PositionMonitor: score < exit threshold, stop/target/time-stop, partial-profit). There is **no opportunity-cost rotation**: no comparison of a new candidate against the *weakest still-held* position, and no "sell the laggard to fund the leader." So capital sits in mediocre-but-above-exit holdings while better alpha goes unfunded.

## Goal
Deterministically rotate capital toward higher expected risk-adjusted return **when, and only when, the edge is material and net-positive after costs/tax/turnover** — reusing the guardrails already in `investment_mandates` (`turnover_budget_monthly`, `min_holding_days`/`max_holding_days`, `tax_sensitivity`, `max_position_pct`) + the CLAUDE.md ~10-position cap. Conservative by default; never churn.

## Non-negotiable rules
1. **Deterministic. No LLM** decides a rotation.
2. **Per-market, per-currency** — never rotate across markets/pools; US $ book and India ₹ book are independent.
3. **Material edge only** — a hysteresis margin, so noise/tiny edges never trigger a swap (same failure class as the phantom-drawdown cascade).
4. **Net-positive after friction** — transaction cost + slippage + tax drag must be *subtracted* from the edge; a rotation must clear that hurdle.
5. **Every existing gate sits above it** — pause, per-market kill switch, `isTradingEnabled`, drawdown breaker, sector/name caps, reentry cooldown. Rotation cannot bypass any.
6. **LIVE rotation is approval-required** (human confirm), like all live orders. Paper may auto-rotate within tight guardrails.

## Trigger + decision (deterministic)
When PaperTrader/Trader has a **qualifying** candidate C (`score ≥ threshold`, long, fresh, passes entry gates) but `cost(C) > cash`:
1. **Re-score holdings** (use the fresh PositionMonitor scores; a holding below its exit threshold is already exiting — not a rotation source). Candidates for sale = holdings **above** exit threshold (still "OK" but maybe weak).
2. Pick the **weakest sellable** W (lowest fresh score; tie-break by lowest expected alpha vs the primary benchmark — see `features/benchmark-alpha`).
3. **Rotate iff ALL hold:**
   - `edge = score(C) − score(W) ≥ rotation_margin` (config; e.g. 12 pts) — *material*.
   - **Alpha-aware:** C's expected excess-vs-benchmark > W's (don't rotate into a lower-alpha name that merely scores higher on a different axis).
   - Selling W (or the minimum lots of W) frees **enough** to fund C at target size.
   - W has satisfied `min_holding_days` (mandate) — no premature flip.
   - The rotation stays within `turnover_budget_monthly` (mandate) — a running monthly turnover counter.
   - **Cost/tax hurdle:** `edge_value − (round-trip cost + slippage + tax_drag(W)) > 0`. `tax_sensitivity` (mandate): prefer selling loss/long-term lots; block a rotation that realizes a short-term gain when tax-sensitive unless the edge dominates.
   - W is **not near its price target** (let winners run — don't rotate out a position about to hit +target).
   - C and W are **not highly correlated** (rotating into a near-duplicate exposure adds no diversification).
4. If all pass → **SELL W (min lots) → BUY C**. Paper: execute within budget. Live: emit an **approval-required proposal** (human clicks), routed through the normal execution gateway + gates.

## Guardrails (conservative defaults)
- `rotation_margin` (score pts), `max_rotations_per_run` (e.g. 1) and `_per_day`, `cash_floor` (never spend below), min free-up efficiency (don't sell a huge winner to fund a marginally-better small position).
- Respect: reentry cooldown (don't re-buy W soon), sector/name/gross-exposure caps, `max_position_pct`, position-count cap.
- **Anti-thrash:** a symbol rotated OUT can't be rotated back IN for N days; a symbol rotated IN can't be a rotation *source* for N days.
- All config lives in `strategy_config` / `investment_mandates` (owner-tunable), OFF by a master `rotation_enabled` flag (default false).

## Failure modes to guard (call out for review)
- **Churn / over-trading** → turnover budget + margin + per-day cap.
- **Tax drag** → tax hurdle + prefer loss/long-term lots.
- **Selling winners** → near-target exclusion + let-winners-run.
- **Whipsaw on noisy scores** → material margin + anti-thrash cooldown; ideally require the edge to persist ≥1 extra run.
- **Correlated swap** (no real improvement) → correlation check.
- **Self-competition** across markets → strictly per-market.
- **Bypassing exits** → rotation never sells a position that would otherwise HOLD past a stop; it only reallocates *discretionary* capital.

## Phasing
- **P1 — PAPER only, gated OFF** (`rotation_enabled=false` default): build the deterministic rotation evaluator + execute paper rotations within guardrails; log every rotation with the full reason (edge, costs, tax, budget). Measure churn + realized benefit before trusting it. Depends on the alpha number from `features/benchmark-alpha` for the alpha-aware term (or falls back to score-only until that lands).
- **P2 — LIVE, approval-required, behind sign-off:** live rotation emits approval-required proposals through the existing gateway; all live gates apply; owner confirms each. Only after P1 shows net-positive, low-churn behavior.

## Files (P1)
`lib/trading/capital-rotation.ts` (deterministic evaluator + selection); wire into `app/api/agents/paper-trade/route.ts` (and `trader` for live proposals) at the `insufficient_cash` branch; `strategy_config` flags (migration); reuse `investment_mandates` guardrails + `paper_trades`/`paper_positions` + PositionMonitor scores; a `rotation_events` audit table (append-only). Docs arch-03/08/09 + system-map. P2 wires the live proposal path (separate).

## Interactions
- Uses `features/benchmark-alpha` for the alpha-aware edge (build that first, or ship score-only and upgrade).
- Complements `features/asset-allocation` (sleeve targets) — rotation operates *within* the equity sleeve.
- Never overrides PositionMonitor exits; it only reallocates capital that would otherwise sit idle in weak-but-holding positions.
