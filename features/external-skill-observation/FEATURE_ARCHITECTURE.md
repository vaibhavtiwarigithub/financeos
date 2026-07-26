# External Skill Observation Adapter

> Status: **DRAFT - NOT APPROVED FOR IMPLEMENTATION**
> Scope: one optional, record-only experiment; no trade influence

## Decision

Do not wire Claude interactive skills, their prompts, or their broker/data tools into
ResearchAgent. `nse-trading-toolkit` is a prompt workflow with optional Groww MCP and
Yahoo/yfinance dependencies, not a deterministic library with a stable output contract.
`garchmethod` may be useful later for a volatility hypothesis, but it is not evidence
that its code or recommendations should enter the money path.

The smallest credible experiment is a Kairos-owned deterministic GARCH(1,1)
**observation** calculated from Kairos-frozen daily returns, written beside existing
research evidence for a single market. It is not sourced from the installed skill and
does not consume a provider key beyond the candle data Kairos already owns.

## Boundaries

- Input: one market-local, immutable daily-return snapshot; no holdings, account,
  broker, token, prompt, or external MCP access.
- Compute: a pinned, reviewed implementation in an isolated offline job, or clean-room
  native deterministic code after a separate license/security review.
- Output: `garch_vol_forecast`, model/version/hash, return-window end date, convergence
  status, and unavailable reason. Finite values only.
- Consumer: evidence ledger/read-only dashboard only. It cannot modify score, rank,
  sizing, stop, target, eligibility, PaperTrader, PositionMonitor, proposals, or orders.

## Why This Is The Right First Step

It tests a measurable claim: whether a market-local volatility forecast improves
forecast calibration or risk diagnostics over realized-volatility baselines. It avoids
the unsafe alternative of treating a natural-language trading framework as an agent
input, and it preserves the option to reject the idea with no production impact.

## Evaluation And Promotion

Compare the observation with predeclared realized-volatility baselines using frozen
walk-forward windows, separately by market, with sample floors and costs where a
future sizing simulation needs them. Register every model/order/window variant in the
trial family. A later sizing change requires its own approved architecture and must
apply in PaperTrader's sizing construction before the execution gateway, never inside
the gateway.

## Explicit Non-Goals

- No automated invocation of Claude skills, Python scripts, Groww/TradingView MCP,
  yfinance, or upstream repo data loaders.
- No API-key sharing, network-enabled GitHub compute, external code execution, or
  provider-quota bypass.
- No direct VCP/CANSLIM/sector-rotation feature added to `agent_signals`.
- No use for US and India together; each model, evidence set, and conclusion is local.

## Prerequisites And Acceptance

Start only after Router cutover/lineage prerequisites and sufficient labeled outcomes
exist for the target market. The build must prove no call path from the observation
to trading, validate deterministic replay from a snapshot hash, report unavailable
rather than fabricate a forecast, and retain the full trial lineage. Any external
repository execution remains governed by
`features/external-research-shadow/FEATURE_ARCHITECTURE.md`.
