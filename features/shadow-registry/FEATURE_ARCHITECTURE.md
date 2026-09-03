# Shadow Registry and Upgrade Path

Status: APPROVED (owner instruction, 2026-07-29)
Owner: Vaibhav
Implementation role: Codex

## Problem

Kairos has several measure-only, counterfactual, and paper-validation programs.
Their evidence is spread across purpose-built ledgers and cron definitions, so
the owner cannot answer five basic questions from the app:

1. What is being measured?
2. What does it cost in provider calls?
3. Has it helped, failed, or merely remained inconclusive?
4. What exact gate remains before it may influence paper or live behavior?
5. How long might that gate take at the observed collection rate?

The absence of one inventory also creates governance drift: an old cron can keep
running after its program becomes idle, and a program may be described as
"shadow" after paper execution has already been enabled.

## Decision

Build an owner-only `/dashboard/upgrade-path` page backed by a typed,
version-controlled registry and live adapters over existing truth ledgers.

Do not create a parallel evidence table. The page reads:

- `provider_call_ledger` and `evidence_policy_evaluations` for Router evidence;
- `shadow_decisions` for setup-expert comparisons;
- `edge_signals`, `edge_ic_history`, and `edge_readiness_status` for technical
  calibration;
- `rotation_config` and `rotation_events` for capital rotation;
- `earnings_risk_observations` for earnings-event risk;
- `international_allocation_*` for allocation evidence;
- `trade_proposals` and `strategy_config` for autonomous-live shadow;
- `strategy_validation_automation` and `strategy_versions` for challenger
  routing;
- a service-only cron-status RPC for schedule truth.

## Product Shape

The left navigation gains `Upgrade Path` under Research.

The shared DashboardShell US/India switch is the sole market authority. The
page must not add a second market picker. Every evidence query, count, verdict,
blocker, and ETA is scoped to the selected market before aggregation. Programs
that do not support the selected market remain visible as `not_applicable`.

The page contains:

- a compact status bar: total programs, actively collecting, review-ready,
  blocked/idle, and provider calls recorded over seven days;
- lifecycle filters;
- one un-nested program row/panel per registry entry;
- purpose and concrete value to Kairos;
- market scope and safety boundary;
- actual schedule state;
- evidence completed, target and progress;
- seven-day collection rate;
- tracked provider calls, cache hits and network attempts when authoritative;
- an honest benefit verdict;
- exact blockers and next owner/engineering action;
- estimated days only when a measurable target and non-zero collection rate
  exist. Otherwise the UI says `No defensible ETA`.
- immutable mainline provenance for every program: first implementation commit,
  entry date, implementation scope, and why inert/measure-only code was merged;
- a separately derived production runtime state (`production_measurement`,
  `production_paper`, `scheduled_idle`, `deployed_inactive`, `not_applicable`,
  or `status_unavailable`) with concrete proof and `why not next stage` text;
- the current Vercel environment and build SHA when Vercel exposes it. A local
  response must say local/unverified rather than claim production deployment.

## Registry Contract

`lib/shadows/registry.ts` is the authoritative descriptive catalog. Every entry
must include:

- stable `id`;
- display name and category;
- supported markets;
- one-sentence purpose;
- product and trader benefit;
- evidence source;
- current and maximum permitted influence;
- activation gate;
- cron job names, if any;
- provider-call accounting mode;
- owner and architecture reference.
- typed `mainline` provenance (`commit`, `enteredAt`,
  `implementationScope`, `reason`).

Mainline provenance is version-controlled history, not a runtime flag. Runtime
deployment is derived from production config, schedules and evidence ledgers.
Neither is allowed to infer that a review-ready program has been promoted.

`lib/shadows/status.ts` owns aggregation and derives a normalized
`ShadowProgramStatus`. It may reference existing ledgers but cannot write them.

The registry also covers the scheduled producer families whose ledgers were
added after the original inventory: `horizon-extension` (the
`horizon_extension_shadow` ledger), `exit-stop-shadow` (`exit_stop_shadow_runs`),
`archetype-ic` (`archetype_ic_runs`), and `alpha-diagnostics`
(`backtest_experiments` rows with `experiment_type='alpha_diagnostic'`). Each
adapter reports market-local row/date progress and latest write time. A scheduled
program with no rows is `scheduled_idle`, not `collecting`.

A coverage test pins the known producers/cron names to registry entries. Future
shadow work is incomplete until this registry is extended.

## Lifecycle Vocabulary

- `collecting`: schedule/trigger is active and evidence is arriving.
- `ready_for_review`: declared evidence gate is met; still no automatic enable.
- `blocked`: evidence or quality gate failed.
- `armed`: automation exists but has no active candidate.
- `paper_active`: paper behavior is enabled; live remains gated.
- `idle`: scheduled but no evidence has arrived in the observation window.
- `off`: schedule/config is disabled.

These labels describe operational state, not expected profitability.

## Benefit Vocabulary

- `benefited`: realized app-specific evidence supports the change.
- `promising`: directional evidence is positive but the activation gate is not
  met.
- `mixed`: evidence differs by market or gate.
- `not_beneficial`: a declared test failed with enough evidence.
- `insufficient`: there is not enough app-specific evidence.
- `operational_only`: the program improves safety/observability rather than
  predicting returns.

The API must not infer `benefited` merely from row count.

## Call Accounting

Provider calls are reported only from authoritative instrumentation:

- Router: `provider_call_ledger`, separating cache hits from leased network
  attempts.
- Reused-input programs: explicitly `0 incremental` when code proves no extra
  provider fetch occurs.
- Uninstrumented programs: `not metered`; never display zero.

Future provider-consuming shadows should write to the existing
`provider_call_ledger` with a stable run prefix instead of creating a new meter.

## Read API

`GET /api/upgrade-path`

- confirmed-owner only via `requireOwner()`;
- uses the service client after the owner gate;
- returns normalized aggregates, no raw provider payloads, credentials, cron
  commands, option chains, account IDs, or source bodies;
- fail-soft per adapter: one unavailable ledger does not erase other programs;
- top-level `generatedAt` makes freshness explicit.

## Approved Cleanup in the Same Change

1. Owner-gate `/api/options/signal`; it spends an external request.
2. Remove dead ResearchAgent prompt text claiming unusual calls should alter
   conviction. Options are not fetched or scored there.
3. Unschedule `kairos-shadow-us` and `kairos-shadow-india`. They produced no
   shadow proposals in seven days while live-auto is disabled. The routes remain
   available for an explicitly approved future campaign.
4. Do not change scoring, options weights, live-auto settings, or broker/order
   behavior.

## Safety

- Page and API are read-only.
- No LLM.
- No scoring or trading consumer.
- US and India metrics stay separate; no currency values are summed.
- A readiness label cannot activate anything.
- Estimates are observational and suppressed when blocked or underidentified.
- Capital rotation must be derived from live config, never hardcoded. It is
  `paper_active` only while `rotation_paper_execute_enabled=true`; after the
  2026-08-11 containment both markets are production shadow measurement with
  paper/live influence disabled.

## Acceptance Criteria

1. Unauthorized requests receive 401/403.
2. Every registry entry has purpose, benefit, evidence source, safety boundary,
   gate, owner, and architecture reference.
3. The API reports live production counts without storing duplicate evidence,
   including every scheduled shadow producer in the registry.
4. Provider calls distinguish tracked network attempts, cache hits, zero
   incremental calls, and unmetered calls.
5. Router remains disabled in both markets.
6. Earnings risk remains `policy_mode='shadow'` and `behavior_changed=false`.
7. Live rotation proposals remain disabled.
8. Autonomous-shadow cron jobs are absent after migration and are not expected
   by stale-check.
9. Options remain absent from `analyst_score`.
10. Desktop and 375px mobile views have no overlap or horizontal page overflow;
    wide detail tables may scroll within their own region.
11. Typecheck, focused tests, full tests, production build, schema verification,
    browser verification, and production deployment pass.
12. Every program shows when and why it entered mainline, current runtime use,
    production proof, and why it has not advanced. `ready_for_review` must never
    be rendered as synonymous with scoring/trading activation.
13. Router readiness uses ten distinct fresh passing market sessions, not one
    passing evaluation or ten arbitrary sessions.
14. Event-driven programs use an independent liveness source where zero events
    can be a legitimate result.

## Production audit — 2026-08-24

The program-by-program audit and production facts are recorded in
`features/shadow-registry/PRODUCTION_AUDIT_2026-08-24.md`. It found one blocked
implementation defect: the setup-expert batch contract conflicts with migration
163's NULLS-NOT-DISTINCT idempotency index, leaving India with zero setup rows
and making multi-expert US observations incomplete. The dashboard exposes the
blocker; repairing the index remains a separately approved schema change.

## Reversal

- Remove the nav/page/API/registry with no evidence loss.
- Reschedule autonomous-shadow jobs from migration `164` only after a new owner
  decision.
- Existing source ledgers remain untouched.
