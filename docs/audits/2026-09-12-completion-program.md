# FinanceOS completion program — 2026-09-12

## Purpose

Replace a collection of plans, partial builds, and stale status headers with one
evidence-backed completion queue. An item is not complete because code exists,
tests pass, or an architecture was approved. It is complete only when its
declared acceptance criteria, production/schema state where applicable, and
end-to-end behavioral proof are recorded.

This is an audit and sequencing record. It does not authorize a score change,
paper/live order, broker configuration, migration application, or strategy
activation.

## Status vocabulary

| Status | Meaning |
|---|---|
| `approved` | Owner approved a bounded architecture; implementation may start only after its prerequisites and task claim are checked. |
| `building` | Code or migration work exists, but acceptance proof is incomplete. |
| `deployed` | Required code/schema is present in the intended environment. This is not behavioral proof. |
| `verified` | End-to-end behavior and safety invariants have been observed and recorded. |
| `blocked` | A named prerequisite or owner decision prevents safe progress. |
| `deferred` | Intentionally not being built, with a revisit trigger. |
| `draft` | A proposal only; it must never be inferred as build authorization. |

## P0 — do not mislabel money-path readiness

1. **Reconcile the live-exit-ladder migration history.**
   - Initial evidence said `20260911122939_live_exit_ladder_safety.sql` was not
     applied because linked production history differed from this checkout.
     A direct production read on 2026-09-12 corrects that conclusion: production
     contains `20260911134352_live_exit_ladder_safety`, and the required
     `live_position_state.state_mode` and
     `direction_flip_armed_session` columns are present. Another checkout
     apparently applied the semantic migration under a different timestamp.
   - Required proof: inventory local and remote migration versions; identify the
     correct repository/project relationship without rewriting history; prove
     schema compatibility, migration-content equivalence, rollback behavior, and
     live-monitor fail-closed paths. Do **not** apply the local migration again
     merely to align its timestamp.
   - State: `schema deployed; repository-history reconciliation and behavioral
     verification blocked`. `live_auto_enabled` remains false.
   - 2026-09-13 correction: production rejects the newly supported
     `score_exit` shadow action while the monitor previously ignored that write
     error. A local, unapplied compatibility migration and fail-visible writer
     repair now exist; see
     `docs/audits/2026-09-13-live-exit-ladder-migration-reconciliation.md`.
     This strengthens—not removes—the history-reconciliation gate.

2. **Close the no-clock exit evidence loop.**
   - Evidence: removing the time stop can leave a position open indefinitely;
     the existing time-review shadow is collecting the evidence rather than
     restoring a clock by assumption.
   - Required proof: a named evidence-driven stalled-position policy, matching
     backtest semantics, and a market-local shadow/replay gate.
   - State: `building / measure-only`.
   - 2026-09-13 correction: the old horizon-extension ledger measures a
     superseded calendar-exit control, not the no-clock policy. Its maturation
     queue starvation defect is repaired locally and tested, but substantive
     no-clock validation requires an approved retention-shadow architecture;
     see `docs/audits/2026-09-13-no-clock-exit-readiness.md`.

3. **Replace the interim exit-geometry baseline only with conditioned,
   frozen evidence.**
   - Current deployed paper path: `resolveExecutionRiskReward` uses the
     entry-candidate, market-local, resolved-horizon ledger distribution:
     p25 MAE for the stop and p75 MFE for the target (minimum 60 labelled
     observations), otherwise the 7% stop / 8% target swing mandate. This is
     deterministic, but global to a market/horizon cohort—not a per-symbol
     technical, fundamental, volatility, or setup-aware policy.
   - Latest immutable run evidence is in `pipeline_stage_events.risk_plan`,
     not a current recomputation: 2026-09-11 India used 3.45% target / 5.34%
     stop from 134 labels; US used 7.86% target / 6.44% stop from 974 labels.
     Completed `paper_trades` stop values may have been trailed or partially
     exited and must not be treated as initial geometry.
   - 2026-09-13 correction: Alpha Diagnostic A4 previously replaced every
     closed lot's barrier levels with fixed 8%/7% values. It now reads the
     levels captured on that closed lot and reports a row as unavailable when
     either barrier is absent. The captured values are exit-time evidence, not
     a substitute for the required immutable entry plan; A4 remains
     descriptive-only.
   - Required proof: an immutable per-entry `ExitGeometryPlan` snapshot with
     as-of cutoff, cohort/sample/version, input values, source and absolute
     levels; paired (not independently optimized) baseline-versus-volatility
     / structure candidates on identical entries, costs, gap/barrier ordering,
     purged walk-forward replay, and daily forward shadows. Fundamental and
     technical research may inform a separately tested thesis/exit condition;
     they must not be asserted to determine a price barrier without evidence.
   - State: `building / interim percentile policy only`; no production target
     or stop formula change is authorized by this audit.

4. **Promote broker tradability from observation to enforcement only when its
   gate is met.**
   - Evidence: broker preflight and Upgrade Path reporting are deployed, while
     enforcement is deliberately gated by ten sessions, disagreement review,
     and separate approval.
   - Required proof: ten market-local sessions, adapter disagreement analysis,
     broker-side symbol/side/fractional proof, and explicit owner approval.
   - State: `deployed, gated`.

5. **Prove complete live readiness as one chain, not feature checkboxes.**
   - Includes fractional quantities, Guardian plans, fill reconciliation,
     partial-target state, score/direction exits, broker preflight, protective
     order capability, kill switch, and real deployment parity.
   - Exit condition: a controlled end-to-end non-money rehearsal and a distinct
     owner decision on manual versus autonomous execution. No automatic enable.
   - State: `blocked by item 1 and owner activation decision`.

## P1 — finish the external-strategy program discussed with Vaibhav

The goal is not to crawl a public site and trade the highest historical curve.
It is to evaluate a small, declared group of reproducible strategies and
combinations against Kairos' current portfolio under costs, point-in-time data,
walk-forward validation, and forward shadow evidence.

1. **Correct the program record.** Reconcile stale headers in
   `features/external-strategy-discovery/FEATURE_ARCHITECTURE.md`: Stage 0R
   replay seam components exist, but catalogue ingestion, sealed OOS results,
   template shadows, and daily forward evidence do not.
2. **Make replay evidence sealable.** Add the missing price-data provenance and
   point-in-time/corporate-action contract, then run one frozen rule through
   costs, next-bar execution, negative controls, and purged walk-forward OOS.
   A full-sample VOO trend replay is diagnostic only and cannot be promoted.
3. **Repair, then deploy, the template-shadow lifecycle only after architecture
   approval.** The currently committed but unapplied migration is not deployable:
   its table requires `rule_version` and `trial_family_id`, while its RPC/API do
   not accept or insert either; its API fingerprint also hashes only market,
   kind, and template IDs. The replacement contract must pass every defining
   field through the owner API and RPC, fingerprint all of them canonically,
   initialize an append-only lifecycle event, and reject incomplete specs.
4. **Run one daily, non-executing forward shadow per market.** It must have a
   scheduled producer, immutable decisions/outcomes, recency status, and an
   Upgrade Path adapter. It cannot influence research, paper positions, or
   brokers.
5. **Build the evidence scorecard after the ledger produces data.** Show stage,
   alpha versus market benchmark, payoff ratio, profit factor, winning weeks,
   evidence count, and governed status. Do not rank by win rate.
6. **Ingest source metadata only.** Public links can supply title, URL,
   category, and independently written rule specifications with attribution;
   no copied article text, paid/gated content, or production crawler.
7. **Treat leveraged ETFs as a separate research family.** TQQQ/SQQQ/SOXL/SOXS
   need their own daily-reset, benchmark, gap/slippage, historical-data, and
   risk-budget contract. They remain blocked from generic research/trading.

Current production evidence: four trial-family rows exist for the external
strategy family; `strategy_template_shadow_configs`, `strategy_library`, and
`strategy_shadow_runs` are absent; `validation_experiments` is empty. The
existing `historical_replay` rows are unrelated older experiments, not evidence
that linked strategies are running.

## P2 — approved/partial work to reconcile after P0/P1

| Program | Current evidence-based state | Required next action |
|---|---|---|
| Broad US broker-compatible universe | architecture says implementing | Reconcile code, data coverage, broker candidate probes, and daily screen/router evidence before widening research. |
| New-symbol/IPO discovery | P0 and filing slice shipped; P1/P2 partial | Complete listing identity/event evidence and 20/40/60-session admission shadows; keep money path off. |
| Shadow population | P0 repair shipped; scheduled challenger proof pending | Observe a real scheduled challenger reaching non-executing shadow state; do not force a synthetic success. |
| Technical calibration / edge discovery | measurement work exists; policy influence gated | Re-run only with correct cohorts/effective samples; close or advance each result through its stated gate. |
| Earnings expectations and peer delta | draft, no recurring capture | Owner decision after provider-budget/data-basis audit; no scoring influence until PIT coverage and shadow evidence exist. |
| Sector regime | draft and blocked by breadth | Complete the broker-compatible universe/data prerequisite before reconsidering. |
| Strategy Evidence Scorecard | draft | Build only after P1 produces real per-strategy evidence. |

## P3 — intentional backlog, not hidden promises

The completion queue will catalogue every remaining architecture as one of:

- `draft`: requires explicit owner approval and a pressure test;
- `deferred`: preserve the reason and objective revisit trigger;
- `rejected`: preserve why it was declined, so it is not proposed again as new;
- `blocked`: name the precise data, provider, legal, or design prerequisite.

Examples currently not authorized for implementation include systematic pattern
discovery (survivorship and multiple-testing blockers), broad automatic strategy
optimisation, unbounded strategy combinations, and live leveraged/inverse ETF
execution.

## Operating rule

The daily completion watchdog reviews `WORK_LOG.md`, approved architectures,
audits, and Upgrade Paths. It reports only meaningful state changes, failed
verification, a ready-to-execute approved item, or a specific owner decision.
Every implementation handoff must update this document's queue and the work log
with the proof actually obtained—not merely the code written.
