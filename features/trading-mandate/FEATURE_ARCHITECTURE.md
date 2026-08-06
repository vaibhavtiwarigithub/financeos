# Feature Architecture: Cross-Market Trading Mandates

## Status

Architecture status: Approved by owner
Approved date: 2026-07-12
Roles: Codex Architect + Builder
Implementation allowed: Yes
Implementation status: Complete and migration 168 applied to FinanceOS production

## Purpose

Give the user an honest, enforceable description of how agents trade without
pretending that a few exit percentages constitute a different investment
strategy. A mandate is configured independently for US and India and separates:

- investment horizon: `short_swing`, `swing`, or `position`;
- strategy preference: `adaptive`, `momentum`, `balanced`, or `value_quality`;
- horizon governance: `user` or `agent`;
- existing-position policy: `grandfather` or `apply`.

Day trading and genuine long-term investing are out of scope. The approved
platform remains long-only and uses once-daily decisions over 2-20 market days.

## Product Contract

| Horizon | Market-day range | Default | Entry | Stop | Target |
| --- | ---: | ---: | ---: | ---: | ---: |
| Short swing | 2-5 | 5 | 65 | 5% | 12% |
| Swing | 5-15 | 10 | 60 | 7% | 20% |
| Position | 10-20 | 20 | 58 | 10% | 30% |

Risk profile remains orthogonal: it controls sizing, concentration, and kill
switches. A mandate controls horizon, evidence emphasis, and exit geometry.

Strategy preferences use bounded deterministic multipliers before weight
renormalization. They do not invent evidence and cannot make an unavailable
dimension available:

- adaptive: champion/default weights unchanged;
- momentum: technical 1.25, sentiment 1.10, fundamental 0.85;
- balanced: all 1.00;
- value_quality: fundamental 1.30, insider 1.10, technical 0.85, sentiment 0.85.

The exact effective weights, mandate version, and governance source are stored
with every decision observation and signal.

## Authority And Precedence

1. Hard safety, liquidity, account, currency, and kill-switch controls always win.
2. The user mandate selects horizon and strategy preference per market.
3. With `horizon_governance=user` (default), the mandate horizon overrides a
   champion genome's horizon. The champion still controls its other validated
   fields.
4. With `horizon_governance=agent`, a valid promoted champion may select horizon
   within the mandate's min/max range; out-of-range values are clamped.
5. Changing a mandate never promotes or mutates a champion.
6. LearnerAgent may propose challengers but cannot change the mandate.

## Existing Positions

Default `grandfather`: each new paper fill stores a mandate snapshot and resolved
horizon. PositionMonitor uses the stored horizon for that position, so changing
Settings does not cause surprise exits. `apply` deliberately applies the current
mandate to open positions on the next monitor run and is visibly labeled.

## Cross-Agent Flow

- Settings: owner-only read/write for US and India mandates.
- ResearchAgent: resolve mandate by symbol market; tilt only applicable+available
  dimension weights; use the mandate entry threshold; persist provenance.
- PaperTrader: require signal/market match; resolve the same mandate; use mandate
  stop, target, and horizon; persist snapshot on position/trade/order event.
- PositionMonitor: count market weekdays, not calendar days; use the fill snapshot
  under grandfather policy; otherwise resolve current mandate/champion precedence.
- TraderAgent/live proposals: include mandate snapshot and horizon in proposal
  rationale/audit. Existing approval, account, LTCM, and notional gates remain.
- LearnerAgent: receives mandate as immutable context. Challengers outside user
  horizon bounds are ineligible; it cannot write mandate rows.
- Backtest/validation: run and report results under the same resolved mandate,
  market calendar, factor tilts, threshold, stop, target, and horizon.
- Explainer/journal: show selected mandate, effective weights, resolved horizon,
  governance source, and whether an existing position was grandfathered.

## Data Contract

New `trading_mandates` table, one row per market:

- `market` primary key (`us|india`)
- `horizon_style`, `strategy_preference`, `horizon_governance`
- `min_hold_days`, `target_hold_days`, `max_hold_days`
- `score_threshold`, `stop_loss_pct`, `target_pct`
- `existing_positions_policy`
- `version`, timestamps, `updated_by`

New nullable provenance columns on paper positions and trades:

- `mandate_version`
- `mandate_snapshot jsonb`
- `resolved_horizon_days`

All writes are owner/service-only. Reads fail closed for trade-affecting paths.
Pre-migration code falls back to the behavior-preserving Position/Balanced
mandate and reports the source as `default`.

## Market Rules

- US and India mandates are independent; no currency or configuration blending.
- Holding age uses each market's weekdays. Exchange-holiday support remains a
  calendar-service follow-up; weekends are never counted.
- US and India can use different strategies because evidence coverage differs.
  Missing dimensions are still excluded before renormalization.

## Non-Goals

- Intraday/day trading, leverage, shorting, options, or crypto.
- A cosmetic `long_term` label for a 20-day strategy.
- Automatic live enablement or order submission.
- Agent mutation of user mandates.
- Retroactive rewriting of historical signals, fills, or outcomes.

## Acceptance Gates

- Per-market settings round-trip independently.
- Research effective weights and thresholds match the selected mandate.
- Unavailable evidence remains unavailable after tilting.
- Paper fills persist a mandate snapshot and resolved horizon.
- Grandfathered positions retain their entry mandate after Settings changes.
- User governance overrides champion horizon; agent governance clamps it.
- US and India tests prove no mandate/currency leakage.
- No live order path is enabled or invoked.
- Tests, typecheck, production build, and dependency audit pass.

## Implementation Result

Implemented 2026-07-12 across Settings, ResearchAgent, PaperTrader,
PositionMonitor, LearnerAgent, and the US proposal-building TraderAgent. Migration
168 was applied directly as one reviewed SQL file to the verified linked FinanceOS
project (`dionkikgdmlaotvtbnfr`) because its timestamped migration ledger does not
align with the repository's numbered local ledger and a broad CLI push could replay
unrelated migrations. The table, US/India seeds, provenance columns, and owner-read
RLS policy were verified from the production schema after application.

## Paper Entry Cadence Correction (2026-07-21)

- Research produces signals only; it never invokes PaperTrader inline.
- Exactly one pg_cron job per market attempts paper entries each regular session.
- PaperTrader independently verifies the market-local session and holiday calendar,
  so UTC/DST drift or a manual invocation cannot create an off-session fill.
- US runs at 15:15 UTC (inside both EDT and EST sessions); India runs at 04:10 UTC
  (09:40 IST). Both retain same-session signal freshness and all existing gates.
- A rejected fill RPC is written to `pipeline_stage_events` and summarized by
  reason in `agent_runs.workload_metrics`; observability never changes eligibility.
- The per-market 10-name default remains a concentration gate, not a cash-use
  target. Idle cash does not authorize an eleventh name or any add to an open
  alpha name. A later fresh score reassesses the holding; it is not a second
  entry instruction without separately validated add-to-winner architecture.
