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

- at least ten distinct trading sessions within the selected session's prior
  45 calendar days and a representative liquid universe;
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
- **One current-condition health event per market** (`evidence-degradation:<market>`),
  never one per symbol or historical run; the detail names the current run and a
  clean run resolves the condition. Run-level history belongs in the append-only
  degradation-event ledger, not System Health.
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

### Deferred after the 2026-07-21 hardening build

- Rollback SLO and any future weakening of approved floors remain owner decisions.
  Section 16 locks the current session, coverage, score, rank, and TTL values.
- The outage drills (§7) — forced timeout, quota exhaustion, schema drift, provider
  disagreement, and complete-primary-provider outage remain unbuilt.
- §9 rollback drill + circuit-breaker triggers.
- The owner-only activation API exists, but no general evaluation-management UI
  is built and both active policies remain disabled.

---

## 15. Implementation Notes — Cohort Builder Built (2026-07-18)

> Historical v1 record. Section 16 supersedes its provider-burst allowance,
> availability-only scoring, placeholder thresholds, and manual-only schedule.

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

---

## 16. Approved Evidence-Hardening Build (2026-07-21)

### Decision record

- **Why:** the daily Router shadow is fresh, but the cutover cohort ran only once,
  could spend provider quota on cache misses, and its single `passed` bit did not
  distinguish entry safety from loss of useful score evidence.
- **Who:** the single Kairos owner operating separate US/USD and India/INR books.
- **ROI:** make cutover evidence repeatable and quota-neutral while preventing a
  technically conservative but materially blinder candidate from being described
  as full parity.
- **Shipped at:** `866548b3` + `cac4cffa`; production verified 2026-07-21.

### Scope and invariants

1. **Cohorts are cache-only.** A cohort may read fresh or policy-allowed stale
   `evidence_cache_v2` rows. It may not acquire a provider lease, enqueue a refresh,
   or call an adapter. A cold field remains unavailable and the evaluation records
   the miss. `primary_provider_calls` must equal zero or the evaluation fails.
2. **Research-output compatibility bridge.** During the existing ResearchAgent
   fetch, Kairos writes canonical cache rows from the data already in memory:
   fundamentals, bars, sentiment, macro, and insider. This is one bounded database
   upsert, not another provider request. Provenance names the compatibility bridge
   and retains the actual serving source in the canonical payload. It is a
   transition adapter, not a new source; future provider-native policies must be
   evaluated separately before removing legacy acquisition.
3. **Market-wide evidence is market-wide.** `macro.regime_inputs` uses the reserved
   `__MARKET__` cache key and is resolved once per market/run. It is never fanned
   out into one provider/cache operation per symbol. India macro remains
   unavailable: the US MacroSentinel cannot be relabelled as India evidence.
4. **Exact score-input replay.** Bridge payloads carry the deterministic dimension
   score and the score input/evidence that produced it. The candidate leg uses that
   score rather than reusing the legacy score by assumption. Provider-native
   canonical payloads must derive the dimension score through the same production
   scoring functions before they can satisfy this gate.
5. **Two machine verdicts.** `safety_pass` covers required-field floors, semantic
   failures, and artifact-created new eligibility. `quality_pass` covers all
   score-affecting coverage loss, material total-score drift, and adverse rank
   displacement. `passed = safety_pass AND quality_pass`; activation requires all
   three fields true.
6. **Rolling proof.** An enabled policy cannot activate from one snapshot. The
   bound activation RPC requires ten distinct market-session evaluations for the
   same market/candidate/baseline/evaluation-code/strategy tuple, all safety- and
   quality-passing within the selected session's prior 45 calendar days, with
   the selected evaluation still unexpired. The session date comes from
   executable ResearchAgent rows (`session_validated=true`, `as_of_session`), so
   weekend/holiday staged rows cannot inflate the count. US and India
   histories never satisfy one another.
7. **Schedule only after hardening.** Run one cohort after each market's final daily
   shadow tick. The route remains shadow-only and both active policy versions keep
   `router_enabled=false`.
8. **Evidence binds the real candidate.** Seed one immutable, inactive
   `router_enabled=true` candidate per market by copying that market's active rules.
   Cohorts resolve cache order under that exact candidate ID. The active pointer is
   not changed, so production remains on the disabled baseline until the bound
   activation RPC eventually clears every gate.

### Approved numeric floors

- Rolling sessions: **10** distinct market-local sessions.
- Required-field coverage non-inferiority margin: **5 percentage points**.
- Any loss of an optional score-affecting dimension is a quality failure when the
  cohort loss exceeds **5 percentage points**; structurally inapplicable fields are
  excluded from the denominator.
- Material aggregate score drift: absolute candidate-vs-legacy difference greater
  than **2 points** for any symbol is a quality failure until owner-reviewed under a
  future provider-change policy.
- Missingness-caused adverse rank displacement: **3 or more places** is a quality
  failure.
- Evaluation validity remains **72 hours**; this is freshness for the selected
  evaluation, not a substitute for the ten-session history.

### Data changes

Add immutable evaluation columns `safety_pass boolean not null`,
`quality_pass boolean not null`, and nullable `market_session_date date` sourced
from validated ResearchAgent sessions (old rows
have no valid session proof). Existing evaluations default both verdicts false, so
an old availability-only run can never authorize cutover. Harden
`activate_evidence_policy_bound()` to require the selected row and the rolling
ten-session history. No new provenance table is introduced: bridge payloads live in
the existing Router cache and immutable decision detail remains in
`evidence_policy_evaluations` / `evidence_evaluation_details`.

### Acceptance

- A cohort test fails if its resolver attempts a provider on a cache miss.
- A warm compatibility row reproduces its recorded dimension and aggregate score.
- Losing macro or sentiment can remain entry-safe but cannot be `quality_pass=true`.
- Macro produces one market-key lookup regardless of cohort size.
- India bars become observable from the Upstox/Yahoo candles already fetched by
  ResearchAgent; no extra Upstox/Yahoo request is made.
- The recurring jobs persist evaluations but cannot activate a policy.
- Every evaluation binds the inactive enabled candidate and the currently active
  disabled baseline; a baseline/candidate change starts a new ten-session series.
- The activation RPC refuses old evaluations, fewer than ten passing sessions,
  wrong-market history, or any safety/quality failure.
- Both production policies remain `router_enabled=false` after deployment.

### Production verification (2026-07-21)

- Applied migrations `router_evidence_hardening` and
  `router_cohort_session_source` in the FinanceOS Supabase project.
- Vercel production deployments for both implementation commits reached Ready.
- US evaluation `a2226bb7-e114-464d-96b8-01ff3684a85a` bound candidate v2 to
  baseline v1 for session 2026-07-20. India evaluation
  `78770c01-4583-49ac-b605-2e82f1730458` did the same for session 2026-07-21.
- Both evaluations recorded zero primary and reverse provider calls with ledger
  proof holding. Both failed safety and quality on current cache coverage, which
  is the required fail-closed startup behavior rather than permission to cut over.
- Active US and India policies remain v1 with `router_enabled=false`. The bound
  activation RPC is executable by `service_role` only.
- Gates: TypeScript clean; 1,162 tests passed / 6 skipped; production build clean.

---

## 16. Parity Evidence State And The ETF Reproduction Bug (2026-08-03)

### Where the gates actually stand

Daily dual-run evaluations have been running since 2026-07-20. Measured from
`evidence_policy_evaluations`:

| | India | US |
|---|---:|---:|
| sessions evaluated | 10 | 10 |
| **sessions passing all machine gates** | **3** | **1** |
| `safety_pass` | 8/13 runs | 2/14 runs |
| `quality_pass` | 3/13 runs | 3/14 runs |
| eligibility flips (§7 floor: zero) | **34** | 3 |
| schema failures | 0 | 0 |
| outage drills recorded (§7 requires them) | **0** | **0** |
| owner reviews of divergences | **0** | **0** |

**Nothing is approvable.** §7 requires ten *passing* sessions, zero unexplained
entry flips, the full outage-drill set, and owner review of every material
divergence. Three of those four are unmet in both markets, and the drill set has
never been started.

Router state is correct and unchanged: `router_enabled = true` exists on v2 for
both markets, but `active_evidence_policy` points at v1 (`router_enabled=false`)
for both. The candidates are inert, exactly as §14 intended.

### The dominant US blocker was our bug, not the router's

`legacy_reproduction_failed` accounted for **45 of ~90 US failures**, on eight
symbols — `DBA, DXJ, EUAD, FEZ, IBIT, IVV, SCHD, VTV` — every one an ETF.

Production caps ETF-like scores at `ETF_SCORE_CAP = 65` in
`lib/research-agent.ts` after the weighted score. The evaluation called
`computeWeightedAnalystScore` directly and skipped it, in **both** legs:

- `lib/evidence/evaluation/cohort.ts` — comment claimed "the EXACT production
  scorer" while omitting the cap;
- `lib/evidence/evaluation/cohort-builder.ts` `scorePathForReport` — the
  legacy-reproduction replay.

Production evidence, 2026-08-03, verbatim:

```
VTV  recorded=65 replayed=76      EUAD recorded=65 replayed=82
IVV  recorded=65 replayed=72      FEZ  recorded=65 replayed=75
```

Every `recorded` is exactly the cap; every `replayed` is the uncapped weighted
score. The legacy-reproduction check exists to prove the harness froze the right
mask and weights — instead it was reporting its own omission as evidence that the
frozen cohort was wrong.

The cap shipped ~2026-07-22 (US ETF scores stop exceeding 65 from 07-23 in
`decision_observations`); the evaluator was never updated to match.

**Fix.** `capEtfLikeScore(score, isEtfLike)` exported from
`lib/scoring/archetypes.ts` and applied at both call sites, keyed on
`shape === "etf" || shape === "metal"`. The metal case matters: `symbolShapeOf`
checks `isMetal` first, so a metal fund never reports `"etf"` even though
production sets `isEtf: true` on the metals basket — keying on `"etf"` alone
would leave GLD/SLV uncapped and reopen the same failure.

Applying it to the candidate leg as well is not optional. Fixing only the replay
would have made `score_delta` compare a capped legacy against an uncapped
candidate for the same symbols, converting a reproduction failure into a
silently wrong drift measurement.

### What this does and does not change

It does **not** move any market closer to activation on its own — it makes the
US measurement mean what it claims. Expect the next US evaluations to drop the
45-occurrence failure class and expose whatever remains underneath. The other
blockers are untouched and still real:

- `score_drift_exceeds_quality_limit` — 29 US, 29 India occurrences. The US
  cases pair with `availability_gain` on TSM, MELI, NVDA, INTC, KR, W: the
  candidate finds *more* data than legacy. That is not automatically good —
  `artifact_created_eligibility:TSM` shows one case where the router made a name
  eligible that legacy did not, which §5 treats as a flip to explain, not a win.
- `unexplained_flip:SBIN.NS` — India, §7 zero-tolerance.
- India's 34 eligibility flips across 10 sessions.
- Zero outage drills.

No tolerance was widened and no gate was relaxed to accommodate any of this.

