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

---

## 14. Implementation Notes — Prerequisites Built (2026-07-16)

> **NOT A CUTOVER.** `router_enabled` remains `false` for BOTH markets; no enabled
> policy version exists; no scorer consumes `EvidenceEnvelope`. Verified in
> production after this change: both markets' active policy version is v1,
> `router_enabled=false`, and zero evaluations exist. This section records the
> machinery that must exist *before* a future owner-approved cutover.

### §3 — Intent classification (`lib/evidence/intent-classification.ts`)

Code-owned. `classifyIntent(intent, market)` returns
`score_affecting | eligibility_affecting | narrative_only | unsupported`. Per §3:
`analyst.consensus` is **narrative_only in US, unsupported in India**, and
`gatedIntents()` excludes it in both — it can never block a scoring cutover, and
India parity for it is not required. `SCORER_FIELD_CONTRACTS` declares, per field:
required intent, minimum field contract (`minFields`/`minCount`), acceptable
quality + freshness ceiling, allowed bases, structural applicability, and the
legacy module/symbol it maps to today. `contractClassViolations()` is asserted by
tests, so a narrative intent cannot quietly acquire a scoring dimension.

**Required (gating) fields:** `technical.daily_bars` (all shapes) and
`fundamental.reported_core` (equity/ADR only). Everything else is optional and
renormalizes exactly as today. `sentiment`/`insider` are deliberately NOT required
— they are genuinely sparse (india:sentiment, us:insider), and requiring them
would abstain on healthy runs.

### §6 — Runtime degradation guard — **SHIPPED IN MEASURE-ONLY MODE**

- Pure core: `lib/evidence/degradation-guard.ts`. Impure shell:
  `lib/evidence/degradation-runtime.ts`. Wired into `lib/research-agent.ts`
  immediately after `resolveSignalDirection`.
- **Mode:** `EVIDENCE_DEGRADATION_GUARD_MODE` ∈ `off | measure_only | enforce`,
  **defaulting to `measure_only`** — it records what it *would* abstain and
  changes no direction. An unparseable value falls back to `measure_only`: a
  broken config can never silently enforce, nor silently stop recording.
- **Strictly subtractive.** `applyDegradationGuard` has exactly one
  transformation: `long → neutral`. `short` (deterministic exit on a holding) and
  `neutral` return untouched in *every* mode — checked before the mode branch, so
  no configuration can make the guard interfere with a sell. This is also enforced
  in the schema (`degradation_guard_is_subtractive` CHECK), so no future code path
  can persist a guard event that created or upsized an entry.
- **Trigger:** a *required*, *applicable* field is unusable **and** the scorer
  renormalized around it (§6.3 — "eligibility depends on renormalizing around that
  degradation"). A required field unusable but *not* renormalized around did not
  shape the decision, so it does not abstain. §6.4 holds: the required-field gate
  fires even when ≥2 other dimensions are present.
- **Defaults to abstain:** no baseline + unusable required field →
  `no_baseline_required_field` → abstain. A persistent outage keeps abstaining; it
  never normalizes, because only a clean run is promoted to baseline.
- **One aggregated health event per run** (`evidence-degradation:<market>:<runKey>`),
  never one per symbol; auto-resolves on a clean run.
- **Known limitation (honest):** the legacy path supplies availability and contract
  satisfaction but *not* observation age, so `ageSeconds` is reported as `null`
  rather than an invented zero. In practice the legacy path therefore exercises
  `available→missing` and `contract_broken`, not `fresh→stale`. The core handles
  age/quality transitions and they are unit-tested; real ages arrive with the
  Router once an intent family is cut over.

### §4/§5 — Frozen dual-run evaluation + activation binding

- `lib/evidence/evaluation/parity.ts` — semantic comparator. Semantic axes
  (nullability → provenance → basis → period → currency → unit → adjustment →
  conflict) are all checked **before** any value comparison, so a numeric tolerance
  is unreachable while the two values describe different facts. Cross-family bases
  (TTM/quarterly/annual/forward) and adjusted/unadjusted are hard mismatches even
  when the numbers are identical. Unknown fields default to exact-match.
- `lib/evidence/evaluation/cohort.ts` — freezes universe/as-of/baseline/candidate/
  strategy/threshold/ranks/price basis; scores **both paths with the production
  scorer and production direction gate** (never a re-implementation); ranks
  cohort-wide; classifies every flip with a bounded cause. Rows where either path
  abstains or fails are first-class. Artifact causes (availability, stale fallback,
  field omission, conflict resolution, basis mapping, renormalization) can never
  create eligibility; a `genuine_value_change` is classified as such but cannot
  self-approve. Becoming *more* conservative never blocks.
- `lib/evidence/evaluation/persist.ts` + `activate_evidence_policy_bound()` — the
  RPC binds approval to candidate + baseline + evaluation ID + evaluation code
  version + strategy version + market + expiry, and additionally requires the
  evaluation's baseline to still be the *active* policy and every flagged
  divergence to carry an approving review row. Production-probed: unknown/stale
  evaluation and invalid market are both refused.

### §8 — Massive candle adapter split (Codex pre-cutover finding)

`price.daily_bars` was one `massive` adapter wrapping `fetchUsCandles()`, which
silently fell back Massive→EODHD→TwelveData while reporting `providerId: "massive"`.
Three harms: provenance named a nominal source; `mode: "only"` could not actually
pin a provider; three providers' pacing/budget accounted as one. Now
`lib/evidence/adapters/bars.ts` builds one adapter per source
(`massive-bars-v1`, `eodhd-bars-v1`, `twelvedata-bars-v1`), each hitting exactly one
provider and refusing a payload that claims another source. The **router** owns the
fallback via the registry chain. Contract version bumped from `us-bars-v2` so
multi-source cache rows are not read back under the new single-source contract.
Note: the resolver's `MAX_SYNC_ATTEMPTS=2` means the third source is reached via the
refresh queue, not synchronously — a deliberate Vercel wall-clock bound.

### Migration

`supabase/migrations/20260716210000_router_cutover_prerequisites.sql` →
`evidence_field_baselines` (mutable — it is a moving reference point, not evidence),
`evidence_degradation_events`, `evidence_evaluation_details`,
`evidence_evaluation_reviews` (all append-only via `no_mutate`), plus frozen-cohort
and binding columns on `evidence_policy_evaluations`. RLS on + owner-read policy on
all four; anon has no grants; writes are service-role only; the RPC is
`security definer` with `search_path=public` and executable by `service_role` only.

### Deferred (not built)

- §7 release evidence floors: the numeric sample floors, tolerances, evaluation
  expiry, and rollback SLO are owner decisions (§13.2) to be set from observed
  traffic. `DEFAULT_EVALUATION_TTL_HOURS=72` and the comparator tolerances in
  `DEFAULT_COMPARATORS` are placeholders pending that approval.
- The outage drills (§7) — forced timeout, quota exhaustion, schema drift, provider
  disagreement, and complete-primary-provider outage remain unbuilt.
- §9 rollback drill + circuit-breaker triggers.
- No API route or UI surface for evaluations/activation.

---

## 15. Implementation Notes — Cohort Builder Built (2026-07-18)

> **STILL NOT A CUTOVER.** Verified in production immediately before and after this
> change: both markets' active policy is v1 with `router_enabled=false`, and no
> scorer consumes `EvidenceEnvelope`. This step only makes the FIRST parity
> evaluations exist. It never activates anything.

### What was built

`lib/evidence/evaluation/cohort-builder.ts` — the piece §14 deliberately deferred
because "a builder that fetches is the step that risks provider bursts."
Exposed as `GET/POST /api/agents/evidence-cohort?market=us|india&limit=N[&dryRun=1]`
(owner- or cron-gated, mirroring `evidence-shadow`).

### §4.2 — ONE frozen observation set, and why the reuse is structural

The governing constraint is that a dual-run must not double provider calls. The
build resolves **one** market-local frozen observation set via the EXISTING
`resolveEvidence` (`allowDisabledPolicy: true`), which shares `evidence_cache_v2`
with the `evidence-shadow` harness — so a warm cache short-circuits at zero cost.

`assembleCohort` is **pure and takes the snapshot as an argument**. It has no
resolver and no network. The reverse-shadow leg therefore *cannot* re-fetch: its
only path to evidence is the frozen `Map`. The reuse is a structural property, not
a caching optimisation that a later refactor could quietly undo.

An earlier draft resolved twice (primary + reverse) and was **caught by its own
ledger proof** — the reverse pass made 12 real bursts. That is precisely the defect
the constraint exists to prevent, and it is why `verifyReverseShadowReuse` now
confirms every `(symbol,intent)` is served from the frozen set rather than
re-resolved.

### The two legs — and what v1 honestly compares

- **legacy** = a real recorded production decision. `agent_signals` joined to its
  `research_packets.raw_data` supplies the exact persisted availability mask
  (`_data_quality`) and the weights that actually drove the score
  (`_profile_weights`). The mask is rebuilt with research-agent's own rule, so the
  leg **reproduces the recorded `analyst_score` exactly** — asserted per symbol and
  reported as `legacyReproduction` (27/27 matched across the first two runs). A
  reconstruction that did not reproduce production would be a guess, not a baseline.
- **candidate** = the SAME frozen dimension scores, with availability decided by the
  router snapshot.

**v1 scope is AVAILABILITY + eligibility-flip parity, and says so.** Legacy never
persisted raw field values or per-field provenance, so a value/basis/period
comparison against it would be fabricated. Both legs therefore carry the field's
canonical contract semantics, `value`/`periodEnd` are left null (not compared), and
the real serving provider is recorded for audit. Note the consequence, stated plainly:
because both values are null, `compareField` short-circuits at the nullability axis,
so basis/period/currency/unit are **not exercised on the production path** in v1 —
they are exercised in tests, and become live when the legacy path is itself routed.
This mirrors the honesty already shipped in the degradation guard (`ageSeconds: null`).

Dimension scores are **not re-derived** from router evidence — no scorer consumes
`EvidenceEnvelope` yet, and inventing one here would mean the evaluation stopped
predicting the thing it claims to predict. The production scorer and production
direction gate are reused unchanged, via `evaluateCohort`.

### First evaluations (real, persisted)

| Market | Symbols | Passed | Flips | Finding |
|---|---|---|---|---|
| US | 15 | **yes** | 0 new-eligible / 0 new-ineligible | Required fields at parity: `technical.daily_bars` and `fundamental.reported_core` both 15/15 vs 15/15. Router **gained** insider coverage (7→10, +20%) — recorded as `availability_gain`, measured not approved. Lost `macro.regime` (−100%) and `sentiment.news_tone` (−86.7%): neither intent has a registered adapter yet, and neither is a required field. |
| India | 12 | **no** | 0 new-eligible / 10 new-ineligible | `coverage_below_non_inferiority_margin` on `technical.daily_bars`: candidate 0.0% vs legacy 100.0%. Correct — every `price.daily_bars` adapter is `markets: ["us"]`, so the router cannot serve India's required field at all. |

The India failure is the gate working, not a defect: US results provide no evidence
for India (§7), and the two were evaluated independently. Scores moved materially in
the US cohort (deltas −28 to +5) without a single threshold crossing — verified per
symbol rather than inferred from the zero-flip count.

### Ledger proof (§4.2), from `provider_call_ledger`

| Run | Ledger rows | Fresh cache | Real bursts |
|---|---|---|---|
| US primary | 50 | 40 | 10 |
| US reverse-shadow | **0** | 0 | **0** |
| India primary | 12 | 6 | 6 |
| India reverse-shadow | **0** | 0 | **0** |

The reverse leg wrote **zero ledger rows** while serving all 75 (US) and 60 (India)
`(symbol,intent)` pairs from the frozen set. Dual-run provider cost therefore equals
the single primary pass — the primary's bursts are the explicit cache misses the
constraint allows. A `denied` lease is deliberately **not** counted as a burst: it is
the pacing system refusing a call, i.e. the protection working.

### Deliberately NOT done

- No migration. Every column `persistEvaluation` writes already existed.
- No activation, and no change to `router_enabled` (still false, both markets).
- §7 numeric floors, tolerances, and evaluation TTL remain owner decisions (§13.2).
  The builder's `coverageNonInferiorityMargin` (0.05) and `maxAdverseRankDisplacement`
  (5) are **placeholders pending that approval**, not approved thresholds.
- ADR shaping: `shapeOf` maps every non-ETF/non-metal symbol to `equity`, so a US ADR
  over-includes the insider field. That is conservative (a coverage miss, never a
  fabricated eligibility) but it is an approximation, not a modelled distinction.
