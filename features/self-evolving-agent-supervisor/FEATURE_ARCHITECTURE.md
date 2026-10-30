# Governed Evolution Supervisor v1

## Status

- Architecture: owner-approved by the prior “go / finish all” direction for the governed self-evolving agent platform; this document narrows the first shippable implementation.
- Implementation: deployed on main (2026-10-28); first natural-cycle persistence check pending.
- Scope: one deterministic supervisory cycle, attached to the existing two-hour watchdog schedule and existing `agent_runs` ledger.
- Markets: US and India kept distinct in every market-scoped row and status.

## Purpose

Kairos already has scheduled researchers, a learner, immutable strategy challengers, deterministic validation, bounded shadow routing, and forward evaluators. They are separate workflows. The missing layer is a reliable supervisor that sees safety/data health and the evolution lifecycle together, puts work in a clear priority order, and does not let a paper-entry brake stop research and shadow evidence from progressing.

The supervisor is a scheduled, event-driven service. It is not an always-running process: the existing serverless/pg_cron schedule wakes it. It does not promise market outperformance.

## V1 flow

1. Read current open System Health alerts.
2. Read recent agent runs and keep only the latest outcome per agent and market.
3. Read per-market strategy challengers, their validation state, and the existing per-market validation automation policy.
4. Build a deduplicated work queue in this order: critical safety/data-integrity issues; failed or degraded producers; approved challengers awaiting deterministic validation; shadow/evidence items that are still collecting or legitimately insufficient.
5. Persist one structured supervisor snapshot as an `agent_runs` operational record, using the existing `workload_metrics` JSON column. Keep the health explanation sanitized; never copy provider errors, credentials, broker data, or secrets into the snapshot.
6. Show the latest snapshot on Agents & Workflows with each market, lifecycle state, blocker, and next safe action.

The supervisor uses the existing `StateGraph` runner. Its nodes inspect and prioritize evidence; they do not invoke LLMs, research providers, broker APIs, learner mutation, position management, or trading routes. Validation and shadow routing remain owned by the already approved validation sweep and its per-market policy. This avoids running duplicate backtests on every watchdog tick.

## Authority and safety

- Deterministic scoring remains authoritative. LLM forecasts remain shadow-only.
- The supervisor cannot change scores, prompts, weights, thresholds, risk limits, model roster, paper positions, cash, orders, or live settings.
- A paper-entry accuracy/drawdown brake can block paper entries without blocking label maturation, diagnostics, deterministic challenger validation, or shadow measurement.
- No strategy is automatically promoted to champion or live. Existing owner promotion and execution gates remain unchanged.
- A missing or failed read is reported as degraded; it is never interpreted as a healthy empty queue.
- Do not create another database table, schedule, provider call, model inference, or paid dependency for V1.

## Acceptance criteria

- Runs from the existing two-hour watchdog; no extra cron is created.
- Captures US and India separately, plus shared-system alerts.
- Prioritizes safety/data integrity before foundations and research/shadow work.
- Reports latest producer status, unvalidated challengers, and legitimately idle/insufficient states without calling them failures.
- Read failures are visible as degraded supervisor output.
- Snapshot persistence and UI use existing `agent_runs` fields only.
- Regression tests prove priority, market isolation, stale failure supersession by a later success, and that a paper gate is not a shadow/validation blocker.
- No trading or provider/model call occurs in the supervisor path.

## Deferred phases

V1 is the supervisory control plane, not a claim that the full self-evolving quant system is complete. Further work remains separately gated by evidence: truly point-in-time causal portfolio replay, out-of-sample strategy comparison at matched opportunity sets, improved setup-specific challenger generation, and statistically supported promotion review. No prompt/genome adaptation or automatic promotion is enabled by this document.

## Owner direction — autonomous strategy lifecycle (2026-10-30)

The later owner instruction supersedes V1's “promotion is never automatic”
statement for research and paper strategy selection. Kairos should run the
candidate lifecycle without asking the owner to choose each model-generated
hypothesis or start each shadow. The LLM proposes bounded, versioned hypotheses;
the deterministic compiler, replay, forward evidence gates, and selector decide
whether to retain, reject, shadow, or select for paper. The owner is informed by
the Learning/System Health surfaces, not asked to operate each transition.

This does not permit LLM output to bypass evidence gates or alter live policy.
Live use remains independently gated by the complete approved mandate and
execution prerequisites. Existing V1 implementation does not yet fulfill this
direction; see the autonomous strategy discovery addendum in
`features/strategy-portfolio-lab/FEATURE_ARCHITECTURE.md` and the work log claim.

### Implementation checkpoint — 2026-10-30

The current code change closes the automatic lifecycle only for LearnerAgent's
dimension-weight challengers: evidence snapshots, fixed matured forward test,
automatic paper-scoring-champion selection/retirement, and Learning status. It
does not yet implement LLM-generated entry/exit-rule discovery or a consumer
that applies selected rule strategies to PaperTrader. The watchdog remains
read-only and does not call models or trading routes. See the remaining rule
strategy gaps in the Strategy Portfolio Lab architecture; do not mark the whole
self-evolving system complete on the basis of this slice.
