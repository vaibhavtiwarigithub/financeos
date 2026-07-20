# Agent Source Pipeline Remediation

Status: APPROVED for implementation by owner on 2026-07-20.

## Problem

The US and India pipelines are correctly separated at their principal scoring and
paper-accounting boundaries, but an adversarial source audit found active quote
coverage, quota, provenance, confidence, and advisory-semantics defects. The most
material defect is PositionMonitor's burst of one unpaced Massive request per US
holding: an unavailable response silently suppresses every mechanical and
conviction exit for that position for the session.

## Scope

1. Make paper-position monitoring price-complete per market and visibly report
   every position that could not be evaluated.
2. Make decision-quality applicability agree with production scoring: India has
   fundamental, technical, and sentiment dimensions today, not US macro.
3. Scope discovery before external work so one market never spends the other
   market's provider budget or broker session.
4. Remove Theme Scout from ResearchAgent's wall-clock budget and make capped
   Alpha Vantage data reserve-only.
5. Record the provider that actually served each evidence item.
6. Stop routine option-chain calls until an approved measure-only experiment has
   a consumer and prospective acceptance test.
7. Keep Holding Risk's deterministic risk posture intact while adding a separate,
   read-only alpha context from already-persisted ResearchAgent output.
8. Repair dormant autonomous-live cross-market assumptions while keeping every
   activation flag unchanged and false.
9. Keep India Learner runs from consuming the US-only macro table and make valid
   green MacroSentinel runs idempotent.
10. State India scanner coverage from measurable freshness instead of claiming
    the rotating cache is simultaneously fresh across the full NSE universe.

## Non-Goals

- No Router or Vibe cutover.
- No autonomous-live activation and no broker/network order test.
- No score-weight, threshold, mandate, kill-switch, or account change.
- No India macro score. That requires a separately reviewed architecture.
- No conversion of Holding Risk into an execution agent.

## Safety Invariants

- No LLM output may set a score, direction, posture, quantity, price, or order.
- A missing quote cannot be treated as a hold; it is an explicit unevaluated state.
- A quote failure for one position cannot suppress exits for positions with valid prices.
- US/USD and India/INR data, outcomes, NAV, mandates, and calibration samples never mix.
- Mechanical exits remain independent of ResearchAgent availability.
- Holding Risk reads persisted alpha evidence only and remains advisory.
- Autonomous-live, Router, Vibe, allocation, and protective-order flags are unchanged.
- Database migrations are forward-only and production definitions are verified after apply.

## Acceptance Criteria

- PositionMonitor resolves US prices through one batched request plus existing
  cache/reserve fallbacks and reports missing symbols in its run result and Health.
- India quality rows no longer count macro as applicable or missing.
- US research does not call Kite/India screening; India research does not call the
  US FinancialDatasets screener or US holdings path.
- ResearchAgent no longer invokes Theme Scout inline and no longer fetches Yahoo
  option chains during routine scoring.
- Evidence records carry actual source and timestamp; unavailable evidence does
  not claim a successful provider.
- Holding Risk publishes alpha score/direction/age/holding-path provenance as
  separate context without changing its risk posture or calling
  ResearchAgent/providers.
- Dormant India autonomous-live uses India pricing, India mandate thresholds, and
  India-only paper calibration; tests prove cross-market records cannot affect it.
- India Learner reports macro unavailable; a healthy green US macro run is reused.
- Scanner responses expose eligible/fresh counts and do not claim all NSE rows are fresh.
- Focused tests, full Vitest, TypeScript, Next production build, secret scan,
  migration verification, and read-only production smoke checks pass.
