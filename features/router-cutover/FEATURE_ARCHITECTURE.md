# Canonical Evidence Router Controlled Cutover

> Status: **REVIEWED DESIGN DRAFT. NOT APPROVED FOR IMPLEMENTATION OR CUTOVER.**
> Last reviewed: 2026-07-15 by Codex.
> Companion authority: `features/data-source-policy/FEATURE_ARCHITECTURE.md`.
> Scope: score-affecting Router activation and rollback, independently per market.

## 1. Current State And Correction

The Router is shadow-only. `resolveEvidence` rejects ordinary callers while the
active immutable policy has `router_enabled=false`; only an explicit shadow caller
may bypass that gate. No scorer currently consumes `EvidenceEnvelope`.

Cutover is not “flip a boolean.” Policy versions are immutable. Enabling or disabling
the Router means creating and atomically activating a new complete market-local
policy version. The policy ID is frozen at run start.

The earlier proposed runtime check (“score with and without the changed dimension”)
is insufficient. It cannot reliably distinguish a genuine new fact from provider
availability, and one-symbol recomputation misses cohort-rank changes. Eligibility
safety therefore has two separate controls: a same-input policy activation gate and
a runtime evidence-degradation gate.

## 2. Invariants

1. US and India policies, universes, caches, evaluations, signals, and rollback are
   independent. Activate one market and one score-affecting intent family at a time.
2. A run freezes policy version, strategy/genome, universe, as-of, and evidence
   snapshot. Mid-run policy activation affects only the next run.
3. Source changes must preserve field semantics: period, basis, unit, currency,
   adjustment, observation time, and knowledge time. “Same or better” coverage is
   not semantic parity.
4. No missing, stale, conflicting, quarantined, or schema-invalid evidence is
   converted to zero/neutral.
5. Provider/routing change alone cannot create a newly eligible long.
6. Existing trading, market-control, kill-switch, drawdown, mandate, rank, approval,
   and execution gates remain unchanged and are rechecked at their existing sites.
7. Cutover changes research evidence acquisition only; it grants no live autonomy.

## 3. Intent Classification

Maintain a code-owned classification:

- `score_affecting`: canonical fields consumed by deterministic dimensions;
- `eligibility_affecting`: prices/events used by filters, freshness, ranks, or gates;
- `narrative_only`: display/context that cannot change score or eligibility; and
- `unsupported`: no valid market capability.

Do not require `analyst.consensus` parity for India or make US narrative analyst data
a scoring cutover blocker. Each scorer field declares its required intent, minimum
field contract, acceptable quality/freshness, and legacy mapping.

## 4. Frozen Dual-Run Evaluation

For each candidate policy version, build one immutable evaluation cohort per market:

1. freeze universe, as-of, active baseline policy, candidate policy, strategy/genome,
   threshold, ranks, and price basis;
2. resolve/cache raw provider observations once where contracts permit;
3. construct legacy and candidate canonical inputs from the same knowledge cutoff;
4. run the full deterministic cohort scorer and all pre-trade eligibility/rank gates;
5. persist field, quality, availability, score, rank, direction, and eligibility
   deltas with evidence fingerprints; and
6. classify every divergence with a bounded code and reviewer note.

The comparison must include symbols where either path abstains or fails. It cannot
compare only jointly successful rows. A reverse-shadow run after cutover reuses the
same frozen observations/cache; it must not double provider bursts.

### Semantic parity

Each canonical field has an explicit comparator:

- exact match for enums, dates, currency, basis, period, and nullability;
- documented numeric tolerance only after unit/period normalization;
- no tolerance across TTM/quarterly/annual/forward or adjusted/unadjusted bases;
- field-level provenance and conflict state retained; and
- unexplained disagreement fails the candidate, even if aggregate score is close.

## 5. Activation-Time Eligibility-Flip Gate

Before a score/eligibility-affecting policy may activate, its immutable evaluation
must prove on the full cohort:

- zero unexplained `ineligible/abstain -> eligible` transitions;
- zero newly eligible transitions caused only by source availability, stale fallback,
  field omission, conflict resolution, basis mapping, or weight renormalization;
- no material adverse rank displacement attributable only to missingness;
- no lower required-field coverage versus baseline beyond a pre-approved non-
  inferiority margin; and
- no schema, currency, market, provenance, or secret-redaction failures.

A genuine evidence-value change may create eligibility only when field semantics are
equivalent, the observation is valid at the shared as-of, and the divergence is
explicitly classified and owner-approved. Added provider coverage is first measured;
it is not silently treated as approval to trade more names.

The activation API/RPC must bind approval to the exact candidate version, baseline
version, evaluation ID, evaluation code version, strategy version, market, and
expiry. A stale evaluation cannot authorize a new policy or changed scorer.

## 6. Runtime Evidence-Degradation Guard

Activation parity cannot prevent later outages. At each research run:

1. evaluate each symbol against the code-owned minimum field/quality contract;
2. compare the current availability/quality mask with the last accepted market-local
   baseline and record transition reasons;
3. if a required field degrades (`fresh -> stale beyond ceiling`, available ->
   missing, valid -> conflict/quarantined), abstain from any new long whose eligibility
   depends on renormalizing around that degradation;
4. apply the existing thin-evidence floor, but do not treat two dimensions as a
   universal assurance when a required gate field is absent;
5. existing holdings continue through PositionMonitor's normal risk/exit logic;
   evidence outage cannot suppress stops or mandatory exits; and
6. emit an aggregated health event, not one alert per symbol.

This guard is deterministic and records baseline/current masks, score/rank
counterfactuals, reason codes, and policy/evidence IDs. It defaults to abstain for new
entries, never to a more permissive score.

## 7. Release Evidence Floors

Calendar days alone are insufficient. For each market and intent family require:

- at least five distinct trading sessions and a representative liquid universe;
- symbol-intent sample counts and sector/industry coverage declared in the report;
- coverage non-inferiority with uncertainty, not only a point estimate;
- organic cache/live/fallback/no-data cases plus forced timeout, quota exhaustion,
  schema drift, provider disagreement, and complete-primary-provider outage drills;
- zero unexplained entry flips and zero market/currency/provenance failures; and
- owner review of every material semantic divergence.

Exact numeric sample floors and tolerances are approved from observed traffic before
release and then versioned. They cannot be weakened in Settings. India must satisfy
its own floors; US results provide no evidence for India.

## 8. Cutover Sequence

1. Complete score-field ownership and legacy-to-canonical compatibility mapping.
2. Add frozen dual-run evaluation and activation binding.
3. Add runtime degradation guard and cohort-rank tests.
4. Keep legacy acquisition warm; run and document a rollback drill.
5. Pilot a narrative-only intent if useful, then one score-affecting intent family in
   one market behind a code-owned compatibility adapter.
6. Create and activate a new `router_enabled=true` policy only after all gates pass.
7. Run candidate primary plus legacy reverse-shadow from shared frozen inputs.
8. Expand intent families, then the second market, through separate evaluations.
9. Remove legacy code only after a separately approved observation period and a
   release proving no rollback dependency remains.

Do not flip all intents or both markets together.

## 9. Rollback And Circuit Breakers

Rollback creates/activates a complete disabled/legacy policy version; it does not
mutate history. Before cutover, prove that legacy credentials, pacing, cache, schemas,
and code still work under realistic load. Define rollback SLO and owner/automatic
triggers for:

- unexplained new eligibility or rank displacement;
- required-field coverage below the approved floor;
- cross-market/currency/basis/provenance failure;
- sustained schema/contract errors, circuit open, or quota exhaustion; and
- evidence-record persistence failure.

Automatic rollback may switch acquisition policy but cannot alter signals/orders
already created. New-entry research pauses during ambiguous partial rollback; the
normal position/execution safety system continues for holdings and exits.

## 10. Data And Audit Changes Required Before Build

Extend `evidence_policy_evaluations` or a linked append-only detail table to retain:

- frozen cohort/snapshot and strategy/genome fingerprints;
- candidate/baseline policy and evaluation-code versions;
- per-field semantic/quality/availability deltas;
- score, rank, direction, and eligibility before/after;
- classified flip cause and reviewer disposition;
- coverage denominators, outage-test results, call usage, and expiry; and
- activation/rollback proof.

Do not store only aggregate `eligibility_flips`. RLS is owner-read, writes are
service-role-only, RPCs use fixed `search_path`, grants exclude anon/authenticated,
and evaluation rows are append-only.

## 11. Required Tests

- policy and strategy freeze across mid-run activation;
- full-cohort ranking under one added/removed/degraded dimension;
- false-to-true eligibility caused by renormalization is blocked;
- genuine same-contract value change is classified, not confused with availability;
- added coverage cannot bypass activation review;
- stale/conflict/quarantined/missing and zero are distinct;
- required-field gate overrides the generic two-dimension floor;
- reverse shadow makes no duplicate live provider burst;
- unsupported India intents abstain without reducing US coverage;
- policy activation rejects stale/wrong-market/wrong-baseline evaluation;
- rollback under load restores the proven legacy path within the SLO;
- position exits and all execution brakes remain active during Router outage; and
- no Router/provider configuration can call an order adapter.

Release still requires typecheck, full tests, production build, schema/RLS/grant
verification, read-only production probes, and per-market shadow/rollback reports.

## 12. Acceptance

Cutover is acceptable only when a future run can reproduce exactly which policy,
facts, availability transitions, score, rank, and gates produced each decision; a
provider outage cannot create a new long; both markets can roll back independently;
and the owner sees an explicit evaluation rather than a generic “parity passed.”

## 13. Owner Decisions Before Build

1. Approve the intent/field ownership matrix.
2. Approve observed sample floors, tolerances, evaluation expiry, and rollback SLO.
3. Choose the first market and first score-affecting intent family after shadow data
   is sufficient.
4. Approve the exact legacy-retirement observation period separately from cutover.
