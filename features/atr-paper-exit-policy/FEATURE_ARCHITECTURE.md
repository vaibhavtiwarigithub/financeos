# ATR Paper Exit Policy

> Status: **DRAFT - NOT APPROVED FOR IMPLEMENTATION**
> Date: 2026-07-22

## Decision

Do not implement fixed `1.5 ATR` partial exits, `2.5 ATR` full exits, or a
`15-point below entry score` hard exit in the current paper loop. Those values
are hypotheses, not validated policy parameters, and would create a second exit
engine beside the existing transactional PositionMonitor path.

Kairos will first measure ATR-normalized exit outcomes in the existing evidence
and validation substrate. A later, explicitly approved version may replace the
current risk/reward policy only after it clears market-local, out-of-sample
validation and paper shadow evidence.

## Why The Handoff Design Cannot Ship As Written

1. `paper_positions`, not `paper_trades`, is the open-state authority.
   `paper_trades` is an immutable lot/realized-outcome ledger. PositionMonitor
   already invokes `execute_paper_exit`, which atomically splits partial lots,
   adjusts the remaining position, credits only the same market pool, and
   preserves FIFO parity. Storing `partial_exit_qty`, `peak_price`, or trailing
   state only on `paper_trades` can re-trigger a partial exit on the same open
   position and break lot/position reconciliation.
2. A `15-point` drop from entry is not the current deterministic thesis rule.
   It would exit an 90-score entry at 74 even while it remains comfortably above
   the market mandate's validated exit threshold. Current score exits use fresh,
   same-market evidence and threshold-minus-hysteresis; this avoids treating a
   still-strong score as a broken thesis.
3. ATR parameters must not be tuned from intuition. Kairos already records MAE,
   MFE, horizons, and point-in-time observations for the specific purpose of
   learning a future volatility/pattern-conditioned risk-reward policy. Fixed
   values would pre-empt that governed surface and contaminate paper outcomes.
4. A once-daily monitor cannot honestly simulate intraday touch-triggered ATR
   barriers. It may evaluate close-based paper exits only unless an approved,
   point-in-time intraday fill model is added. It must not call a daily close a
   fill at a level that may never have been executable.

## Existing Policy To Preserve

- PaperTrader binds every fill to an entry-time stop and target through
  `resolveExecutionRiskReward` and `bindTradePrices`.
- The source is the market-local mandate until at least 60 eligible MAE/MFE
  labels support a learned alternative.
- PositionMonitor is the only paper exit executor. It runs time, fresh
  score/direction, stop, target, and existing one-time half-target logic in a
  defined order, then calls the service-only `execute_paper_exit` RPC.
- The RPC owns FIFO lot closure, remaining quantity, cash, native currency, and
  decision journal writes. No new client or route may bypass it.
- US and India stay separate for prices, ATR units, data sources, policy
  evidence, positions, cash, and evaluation.

## Measure-Only Phase (Proposed)

1. Extend immutable `decision_observations` / `observation_labels`, not the
   execution tables, with derived ATR-normalized MAE/MFE diagnostics where the
   entry candle history is adequate. Record null rather than inventing an ATR.
2. Evaluate a small, predeclared family of stop/target/trail candidates per
   market and horizon against the same frozen entry opportunities. Include
   spread/slippage and a conservative daily-bar ambiguity policy.
3. Use purged walk-forward splits, a locked holdout, costs, turnover, drawdown,
   and trial-family correction. Require enough independent labels; never pool
   US and India.
4. Write only Edge/validation evidence and health telemetry. No change to
   `agent_signals`, PaperTrader, PositionMonitor, positions, cash, broker
   proposals, or live orders.

## Later Paper Shadow Gate

After a candidate is statistically eligible, run it as a market-local,
non-executing shadow beside the incumbent exit policy. It must use the same
entry price, quote source, close convention, slippage model, and horizon. It
may become a paper policy only after non-inferiority on drawdown and net return,
no material turnover regression, reproducible records, and explicit owner
approval.

## Explicit Non-Goals

- No broker-hosted stops, protective orders, live execution, Webull enablement,
  router enablement, or change to `protective_orders_enabled`.
- No re-entry exception that bypasses the existing name cap, cooldown,
  deterministic score, market-control, or kill-switch gates.
- No hardcoded ATR multiplier or score-velocity constant in the money path.
- No `paper_trades` mutation that represents live position state.

## Acceptance Criteria For A Future Implementation

- One versioned exit policy owns all partial/full paper exits.
- State lives on `paper_positions` and all transitions use
  `execute_paper_exit` in a single transaction.
- Every exit is reproducible from versioned evidence and a documented fill
  convention.
- The policy is separately validated and market-local; it does not borrow US
  results to configure India or vice versa.
- Existing exits, cash accounting, FIFO parity, long-only constraints, kill
  switches, and fresh-score protections remain intact.

## Evidence Basis

- Kaminski and Lo show that whether a stop-loss adds value depends on the return
  process and regime rather than a universal parameter. Kairos must therefore
  validate its own market-local policy out of sample, net of costs.
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=968338
- Hsu, Taylor, and Wang found that strategies selected in sample can fail out of
  sample even when stop-loss variants are considered. This is why the candidate
  family, holdout, and trial-history record are mandatory rather than optional.
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3158101
