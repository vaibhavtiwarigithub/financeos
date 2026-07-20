# Feature: Research-Time Indicative Trade Plan

Status: APPROVED / BUILDING (2026-07-20) · Owner: Vaibhav · Builder: Codex

## Problem

Research Journal explains why a symbol passed or failed, but does not show the
native-currency price used by research or translate the active mandate into an
approximate risk/return plan. Downstream execution already creates absolute
stops and targets at fill time, so adding independent LLM-generated prices would
create two conflicting truths on the money path.

## Decision

Record a deterministic, point-in-time **indicative plan** from the candle already
used by ResearchAgent. Show it in Research Journal as:

- research reference price and market date/source;
- for an eligible new long: approximate initial risk floor, profit objective,
  percentages, and target horizon;
- for a rejected/neutral symbol: reference price plus `No entry plan`;
- for a held symbol: reference price plus `PositionMonitor owns the executable
  exit plan` so a newly computed scenario cannot overwrite the position's
  fill-bound stop/target.

This is not a predicted fair value, limit order, broker stop, guaranteed exit, or
new score dimension. FINRA warns that a stop price is not a guaranteed execution
price and can execute materially differently in volatile markets; the product
must not label an indicative level as an execution promise.

## Contracts

### Shared deterministic module

`lib/trading/trade-plan.ts` owns two pure contracts:

1. `buildIndicativeTradePlan`: binds the latest validated research candle to the
   current per-market mandate. It performs no fetch and no LLM call.
2. `resolveExecutionRiskReward`: selects fill-time stop/target percentages. A
   valid ledger MAE/MFE distribution with at least 60 eligible-long outcomes for
   the same market/horizon uses the approved clamps (maximum 10% MAE stop and
   40% MFE target); malformed/thin learned data falls back to the current mandate.

Both contracts reject non-finite/non-positive prices and preserve native market
currency (`USD` for US, `INR` for India).

### Persistence

No migration is required. Use the existing immutable ledger:

- `decision_observations.price_at_decision`: latest candle close used by scoring;
- `decision_observations.currency`: existing native-currency field;
- `decision_observations.features.trade_plan`: versioned indicative plan;
- `agent_signals.stop_loss_pct` / `take_profit_pct`: research-time mandate
  snapshot for downstream audit/comparison, never an executable absolute price.

Historical null rows remain unchanged. The Journal must report them as
unavailable rather than backfilling with current prices.

## Agent Ownership

- **ResearchAgent:** records the point-in-time reference and indicative plan.
- **PaperTrader:** fetches a fresh market-local quote, re-resolves current
  mandate/validated MAE-MFE policy, anchors absolute levels to the actual fill,
  and logs planned-versus-bound values. Research prices never authorize a fill.
- **PositionMonitor:** remains the sole owner of paper stop, target, trailing,
  score-exit, and time-exit decisions from `paper_positions`. Research cannot
  loosen or replace those levels.
- **Live Trader/broker adapters:** unchanged. Existing quote freshness, approval,
  pause, kill-switch, account, and order gates remain authoritative.
- **LearnerAgent:** may evaluate eventual MAE/MFE outcomes through the existing
  observation ledger. It cannot invent or directly mutate plan levels.

## Safety Invariants

1. No LLM-generated number enters the plan or money path.
2. US and India plans never share prices, currencies, mandates, or learned samples.
3. A missing/stale/non-positive research price produces `unavailable`, never a
   fabricated level.
4. Research levels cannot bypass signal/session freshness, portfolio, cash,
   pause, kill-switch, approval, broker, or execution-price gates.
5. Fill-time levels are anchored to the actual fill, not the research close.
6. Held-position exits always use the stored position plan; the Journal labels
   research levels as context only.
7. Stop/target prices are estimates, not guaranteed executions.

## UI

Add an unframed `Indicative plan` row in each Research Journal symbol detail:

- `Reference`, `Initial risk floor`, `Profit objective`, `Horizon`;
- market-native currency formatting;
- source/as-of metadata;
- concise disclosure: `Repriced at fill; not an order or guaranteed execution.`

Do not show red/green prices for rejected/neutral symbols as though a trade is
planned. Do not add controls that place orders from the Journal.

## Acceptance Criteria

- A new US and India observation stores the actual latest scoring-candle close,
  native currency, source/date, and a versioned plan without extra provider calls.
- Eligible new longs show approximate entry/risk/target; rejected and held names
  show truthful non-entry/position-owned states.
- PaperTrader uses valid ledger percentiles when available, applies documented
  bounds, falls back on malformed/thin data, and anchors levels to fill price.
- Journal API/UI render old null-price rows honestly.
- Focused unit tests cover invalid values, both currencies, held/rejected states,
  learned-policy bounds/fallback, and fill anchoring.
- TypeScript, full unit suite, production build, and diff checks pass.

## Reversal

Remove the Journal rendering and stop writing `features.trade_plan`. Existing
JSONB observations remain harmless audit history. The fill-time resolver can be
returned to mandate-only behavior independently; no position or order migration
is required.

## V2: Position And Outcome Truth (Approved 2026-07-20)

The Journal must not make the research-time scenario look like the currently
managed trade. It adds three independent, explicitly labelled overlays:

1. **Current paper position:** read from `paper_positions` for the same market
   and symbol. Show actual average cost, current price, stored initial/current
   stop, target, quantity, and update time. These stored fields remain owned by
   PaperTrader and PositionMonitor.
2. **Current live holding:** read only from the latest
   `live_account_snapshots` row for the configured active account. Never make a
   broker request from the Journal and never merge accounts or markets. A live
   holding is `managed` only when a filled Kairos BUY proposal for that exact
   active account carries a valid deterministic execution policy; otherwise it
   is truthfully labelled `unmanaged_by_kairos` and no stop/target is invented.
3. **Realized paper outcome:** join `paper_trades` by the exact `signal_id` and
   show fill, exit, P&L, close time, and exit reason. Symbol-only matching is
   forbidden because it can attach a later trade to an older decision.

The API also reports exit-policy learning readiness as eligible same-market,
same-horizon long labels `n / 60`. Thin data continues to use the mandate. This
is observability only and cannot lower the 60-sample gate.

### Dormant Live-Exit Contract

Before live autonomy can ever be enabled, every autonomous BUY proposal records
the deterministic fill-time percentage policy, horizon, mandate version, and
policy source in `trade_proposals.policy_snapshot`. Absolute levels are rebound
to the broker's actual average fill.

The dormant live exit monitor must:

- include only filled orders whose `proposal_id` resolves to the configured
  active account; missing proposal/account lineage fails closed;
- reconstruct remaining lots FIFO so partial sells remove quantity and cost
  basis together;
- use the remaining lots' recorded policies, with the current per-market
  mandate only as a clearly marked fallback for legacy Kairos lots;
- use the fill-recorded resolved horizon and count market sessions exactly as
  Paper PositionMonitor does; legacy Kairos lots fall back to the mandate;
- never auto-manage broker holdings that predate Kairos order lineage;
- surface database read failures rather than silently treating them as no
  positions.

These changes do not activate `AUTONOMOUS_LIVE_ENABLED`, `live_auto_enabled`,
broker-hosted protection, Webull trading, or any order canary. Owner approval,
account capability proof, and a small manually approved canary remain separate
deployment gates.
