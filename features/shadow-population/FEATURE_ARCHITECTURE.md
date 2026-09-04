# Shadow-Population Strategy Search — Feature Architecture

> Status: **DRAFT v2 — RESHAPE. P0 IN PROGRESS (Vaibhav approved P0 only, 2026-09-04).**
> Original author: Claude (Sonnet 5), 2026-09-04.
> Adversarial review: Codex (GPT-5), 2026-09-04.
> P0 implementation: Claude (Sonnet 5), 2026-09-04 — see `docs/arch/04-database-schema.md`'s
> `strategy_versions` entry for the applied migration. P1/P2/P3 remain unauthorized: no capacity
> change, automatic eviction, ranking, scoring, sizing, exit, order, or live-capital change.

## 0a. P0 progress (2026-09-04, this session)

Steps 1–2 of §3's P0 list are done and verified live in production; steps 3–5 are partial:

1. ✅ `challenger` added to `strategy_versions_state_check` — migration
   `20260904120000_shadow_population_p0_challenger_state.sql`, additive, applied.
2. ✅ Partial unique index `strategy_versions_one_champion_per_market (market) where
   is_champion = true` — same migration, applied. Production held exactly one champion per
   market before the change (verified), so it applied with zero conflict.
3. **Partial.** Structural proof done: a rolled-back production transaction confirmed a
   `state='challenger'` row now persists and confirmed the new index correctly rejects a
   synthetic duplicate champion. **Not yet done:** verifying the first *genuine, scheduled*
   challenger reaches `shadow_paper` with recorded non-executing observations — that requires
   either the Friday `kairos-validation-sweep` or a real LearnerAgent weight-mutation proposal to
   actually fire against the repaired schema, and is a future event to check for, not something
   forceable synchronously.
4. **Done, structurally.** The learner's challenger-insert path already checked `insErr` and
   returned an explicit `challenger_created: false` error before this change — that half of
   "explicit failure states" predates P0. What P0 adds: `lib/validation/strategy-states.ts` as a
   single shared TS source of truth for the `"challenger"`/`"shadow_paper"` literals, wired into
   all 4 existing call sites (`app/api/agents/learner/route.ts`,
   `app/api/validation/sweep/route.ts`, `lib/research-agent.ts`, `lib/shadows/status.ts`) — this
   closes the actual defect class (independent literals that can silently drift from the DB
   constraint and from each other) rather than only the one symptom already fixed in `2e5021ba`.
5. ✅ Capacity left at `max_active_shadows = 1` for both markets — unchanged, per P0's own
   instruction not to widen it yet.

**What "P0 complete" still requires**: acceptance criterion #1 in §5 — a real scheduled run, not
a synthetic proof. Check `validation_experiments` and `strategy_versions.state='shadow_paper'`
counts again after the next Friday sweep or the next LearnerAgent run that proposes a mutation.

## 0. Decision

The product direction is sound: keep a small set of non-executing challengers, measure them
prospectively, and leave promotion owner-only. The original implementation sequence is not
safe yet. The existing one-shadow path has never produced a production shadow and currently
cannot accept the `challenger` rows that feed its weekly sweep.

Proceed in independently approved stages:

1. **P0 — repair and prove the existing one-shadow pipeline.**
2. **P1 — raise capacity to three and complete existing UI surfaces.**
3. **P2 — add matched-window comparative evaluation after prospective data exists.**
4. **P3 — consider automatic eviction only after P2 has demonstrated stable evidence.**

Do not implement IC-only ranking, automatic eviction, a five-resident population, free-form
strategy generation, or live multi-strategy execution now.

## 1. Corrections from the review

### 1.1 Learner run 20 was not a correct no-new-data abstention

Production contains four US paper-trade closure rows between the 2026-08-28 and 2026-09-04
learner runs; the reported closed total rose from 73 to 77. The fallback Mermaid's
`0 trades closed this run` label was actually displaying the count of orphan outcomes
reconciled during that invocation. It also said macro was not checked and priors were not
loaded even though the recorded reasoning chain shows both happened.

The substantive failure was in `loadLabeledDataset`: it put roughly 6,000 observation IDs
into one PostgREST `.in(...)` URL. The failed label request was converted to an empty cohort,
so every score-correlation call fell back to a one-row trade join even though production has
2,327 non-null US h10 benchmark-neutral labels across 31 dates.

The existing-bug repair is separate from this feature: label reads are now bounded in batches,
read errors propagate, and fallback Mermaid labels report corpus/reconciliation facts rather
than inventing a no-new-trades explanation. This repair does not activate any shadow.

### 1.2 The current pipeline is not operationally proven

Verified production state on 2026-09-04:

- both automation policies are enabled with auto-shadow on and capacity one;
- there are zero `shadow_paper` versions, zero policy-version shadow decisions, and zero
  validation experiments;
- the database `strategy_versions.state` check does not permit `challenger`, while
  LearnerAgent inserts `challenger` and the Friday validation sweep queries `challenger`.

The missing state is a hard P0 prerequisite. Clearing a lifetime closed-trade count justified
revisiting the feature; it did not prove this prospective pipeline or supply ranking evidence.

### 1.3 The executable genome is narrower than documented

Today the learner proposes weight mutations, validation reads `weights_snapshot`, and
ResearchAgent replays only `weights_snapshot`. `genomeDiffCount()` has no runtime consumer.
Horizon, exit, sizing, and universe fields therefore are not a live coordinate-search space.
Expanding those policy fields requires separate replay contracts and must not be represented
as already available.

### 1.4 Existing visibility must be extended, not duplicated

- `AgentsPage.tsx` already has a Strategy Versions surface and shows state/validation.
- `ValidationAutomationPanel.tsx` already owns the enable/auto-shadow settings, but the API
  hardcodes capacity one and the UI has no capacity selector.
- Upgrade Path already registers `challenger-validation` and reports shadow count/readiness.
  All shadow programs must continue to appear there, per the product's established rule.

### 1.5 The original comparison and statistics were invalid

Admission `challengerScore` is mean benchmark-neutral log growth; resident IC is a rank
correlation. They have different units and cannot be compared for eviction. Shadows admitted
at different times also cannot be ranked fairly on their separate lifetime windows.

Both evidence floors apply: at least 20 predictive dates and at least 12 horizon-adjusted
effective observations (`n_eff = qualifying_sessions / horizon_days`). At h10 that implies
about 120 qualifying sessions, not 12 rows or one week.

Šidák controls family-wise error; FDR is a different procedure. Testing K variants every week
also creates repeated-look risk. Any significance claim must predeclare both the variant family
and evaluation checkpoints, then apply an explicit correction across both.

## 2. Target system boundary

The target remains one champion per market and up to three non-executing shadow residents.
Shadows never place orders, receive capital, or self-promote. The owner can promote one version
through the existing governed path only after reviewing its evidence.

Identity is the immutable version/genome hash plus a deterministic diff label such as
`technical_weight: 0.25→0.30`. LLM-created names are prohibited. Generation initially remains
one bounded weight change at a time.

**Forward reference (2026-09-04).** `features/robinhood-crypto/FEATURE_ARCHITECTURE.md` raises
the question of a genome that differs by instrument family (crypto/ETF/equity), not just by
market. This document's position is unchanged: not now. One market's genome population isn't even
proven with a single real shadow yet (§0a); splitting further by instrument family multiplies the
same sample-starvation problem this whole feature exists to respect. Revisit only after (a) this
feature's own P1 has demonstrated a working population and (b) crypto (or another family) has
enough real paper history of its own to support a separate genome without starving it.

## 3. Staged implementation

### P0 — repair and prove one shadow (separate approval required)

1. Add `challenger` to the `strategy_versions.state` database constraint without removing any
   current state.
2. Add a partial unique constraint that permits at most one champion per market; the current
   advisory lock protects the promotion RPC but a non-unique index does not protect direct
   privileged writes.
3. Test the real lifecycle: create challenger → validate → activate as `shadow_paper` → record
   non-executing decisions. Use a rolled-back transaction for structural proof and then verify
   the first genuine scheduled run in production.
4. Make the sweep and learner expose explicit failure states; absence of rows must not look like
   a quiet successful run.
5. Keep capacity at one until a real resident has accumulated prospective decisions.

### P1 — bounded population and complete visibility (later approval)

1. Widen the capacity constraint to `0..3`; preserve the stored default/value of one.
2. Let the owner settings API and `ValidationAutomationPanel` accept an integer capacity 0..3.
3. Change ResearchAgent's resident query to a deterministic order and ensure its replay limit
   equals the schema ceiling of three. Every admitted resident must receive every eligible
   shadow observation; admission is refused if that invariant cannot be met.
4. Extend the existing Agents Strategy Versions surface with genome diff, admission date,
   observation count, evidence state, and owner actions.
5. Extend the existing Upgrade Path `challenger-validation` adapter with per-market resident
   freshness, latest scheduled result, failure reason, and capacity. Do not create a competing
   dashboard.
6. When full, refuse admission and require manual retirement. No automatic eviction in P1.

### P2 — comparative evidence ledger (after prospective data exists)

At each predeclared checkpoint, evaluate champion and residents on the intersection of the same
observation IDs and decision dates. Never compare separate lifetime windows.

Primary objective: paired benchmark-neutral log-growth/selection impact aligned with the
admission validator. Secondary diagnostics: session-level rank IC, drawdown proxy, turnover,
and coverage. A challenger cannot be called superior unless both sample floors clear and the
corrected paired comparison passes. Otherwise its state is `collecting` or `inconclusive`.

Add an immutable evaluation ledger with, at minimum:

- market, policy-version ID, as-of date, horizon, and common-window fingerprint;
- row count, qualifying sessions, effective observations, and coverage;
- primary paired objective, delta versus champion, session-level IC, adjusted probability,
  correction family/checkpoint, and classification;
- unique key over policy version, horizon, as-of date, and common-window fingerprint.

The Friday sweep may compute these records only after its route is explicitly extended; the
current sweep validates queued challengers and does not rank residents.

### P3 — automatic eviction (deferred)

Only propose eviction after P2 has accumulated enough prospective checkpoints to estimate
stability. Any later policy must compare residents on a common window, enforce minimum tenure,
use the same-unit primary objective, account for repeated looks, log the decision immutably,
and remain independently disableable. Until separately approved, retirement is manual.

## 4. Files in scope for a future Builder

P0:

- a new migration for the `challenger` state and champion uniqueness;
- `app/api/agents/learner/route.ts`, `app/api/validation/sweep/route.ts`, and lifecycle tests;
- deployment/runbook verification evidence.

P1:

- a capacity migration;
- `app/api/settings/validation-automation/route.ts`;
- `components/dashboard/ValidationAutomationPanel.tsx`;
- `lib/research-agent.ts`;
- the existing strategy-version UI in `components/dashboard/AgentsPage.tsx`;
- `lib/shadows/registry.ts` and the existing Upgrade Path status adapter;
- API and mutation-detection tests for capacity, replay coverage, and non-execution.

P2:

- a new immutable evaluation-ledger migration;
- a paired common-window evaluator;
- `app/api/validation/sweep/route.ts` scheduling integration;
- existing Agents/Upgrade Path API and UI adapters;
- tests for mismatched windows, both sample floors, repeated-look correction, and immutable
  outcomes.

## 5. Acceptance criteria

1. P0 cannot report success until one real scheduled challenger reaches shadow and records
   non-executing observations; local tests are not deployed verification.
2. Every active resident is replayed on the same eligible observation stream; missed coverage
   is a visible failure, not silently ignored.
3. The database prevents more than one champion per market.
4. Capacity is consistent across schema, RPC, settings API, UI, and ResearchAgent replay.
5. `collecting` is shown until both 20 predictive dates and 12 effective observations clear.
6. Comparative claims use a paired common window and commensurate metrics.
7. Multiple-variant and repeated-checkpoint error control is named, implemented, and recorded;
   FWER and FDR are never conflated.
8. All shadows and their latest results remain visible in Upgrade Path, with the Agents page
   serving as the detailed management view.
9. No shadow places orders, receives live capital, or promotes itself.
10. Mutation tests must fail when challenger-state support, capacity agreement, replay coverage,
    single-champion uniqueness, evidence floors, or non-execution guards are removed.

## 6. Decisions still requiring Vaibhav's approval

1. Approve P0 only: repair and prove the existing one-shadow path.
2. After P0 evidence exists, decide whether to approve P1 with ceiling three.
3. Approve the P2 objective/checkpoint protocol only after the first prospective sample allows
   its feasibility to be measured.
4. Keep P3 automatic eviction deferred unless a later evidence review explicitly reopens it.

## 7. Explicit non-goals

- no live-capital multi-strategy tournament;
- no automatic promotion or eviction in P0/P1;
- no LLM-invented names or unbounded strategy generation;
- no claim that exit/sizing/horizon/universe genome fields are executable today;
- no retrospective rewriting of evidence and no silent fallback on data-read failure;
- no removal of shadow status from Upgrade Path.
