# Shadow Population and Learner Run 20 — Codex Review

Date: 2026-09-04  
Scope: independently verify the supplied run-20 diagnosis and shadow-population architecture,
repair existing-code defects found during review, and revise the draft architecture. No
shadow-population schema or money-path change was authorized or made.

## Verdict

**Run-20 diagnosis: incorrect.** Four US closure rows exist between the 2026-08-28 and
2026-09-04 runs. The Mermaid's zero was orphan reconciliation, not new closures. The run
reported 77 lifetime closed rows versus 73 in the prior run.

**Root cause: confirmed existing-code defect.** The learner loaded roughly 6,000 observation
IDs and sent them in one PostgREST `.in(...)` request for labels. That request failed, and the
loader silently returned an empty cohort. Production contains 2,327 non-null US h10
benchmark-neutral labels across 31 dates, but the correlation tools fell back to a one-row
trade join and returned insufficient data.

**Architecture: reshape before approval.** The product direction is good, but the proposed
five-shadow/IC-ranking/automatic-eviction sequence assumes infrastructure that is neither
operational nor internally consistent. P0 must repair and prove one shadow first.

## Production evidence

- Latest US learner run: 2026-09-04, total closed 77.
- Previous US learner run: 2026-08-28, total closed 73.
- Four intervening closure rows: LLY, PBR, KGC (partial exit), and COST.
- The run recorded 17 tool steps. Priors were loaded and macro was checked.
- The agent did not emit a finish payload before the iteration limit; fallback Mermaid ran.
- Decision observations: 5,984 US rows.
- US h10 labels: 2,338 total; 2,327 with non-null benchmark-neutral return; 31 dates.
- Automation policies: enabled and auto-shadow enabled for both markets, capacity one.
- Strategy versions: two `paper_active` rows, zero `shadow_paper` rows.
- Policy-version shadow decisions: zero.
- Validation experiments: zero.
- Production state constraint omits `challenger`; learner writes it and weekly sweep reads it.

The production queries were read-only. No database mutation or migration was executed.

## Existing-code fixes

1. Label queries are split into bounded 500-ID batches.
2. A failed label batch now throws a named error instead of masquerading as an empty cohort.
3. Fallback Mermaid distinguishes total learning-corpus rows from orphan outcomes reconciled in
   this run.
4. Fallback Mermaid derives macro/prior status from the recorded tool trace and declares the
   missing finish payload.
5. Tests cover batching, error propagation, and truthful fallback labels.

Mutation verification: increasing the batch size so the safeguard was effectively removed made
the batching detector fail.

## Architecture findings

1. The missing `challenger` database state blocks the present pipeline before population size
   matters.
2. The existing automation has produced no prospective shadow evidence.
3. ResearchAgent reads at most three shadows, so a capacity ceiling of five would silently omit
   admitted residents.
4. Runtime replay and validation consume weights only; the broader typed genome is not an
   executable coordinate-search system.
5. Strategy Versions UI, validation settings UI, and an Upgrade Path entry already exist and
   should be extended rather than replaced.
6. Admission log-growth and resident IC are different quantities and cannot be compared for
   eviction.
7. Residents admitted at different times require a paired common observation/date window.
8. Both 20 predictive dates and 12 horizon-adjusted effective observations are required; h10
   therefore needs about 120 qualifying sessions.
9. Šidák is FWER control, not FDR. Weekly re-evaluation additionally requires predeclared
   checkpoints and repeated-look correction.
10. The current non-unique champion index does not make one champion per market a database
    invariant.

## Recommended sequence

- P0: add the missing state and champion uniqueness in a separately approved migration; prove
  one real shadow lifecycle while capacity stays one.
- P1: after P0 production evidence, raise the ceiling to three, align schema/API/UI/runtime
  capacity, and extend Agents plus Upgrade Path. Refuse at capacity; retire manually.
- P2: after prospective data accrues, add an immutable paired common-window evaluation ledger.
- P3: reconsider automatic eviction only after P2 demonstrates enough stable evidence.

The authoritative revised draft is
`features/shadow-population/FEATURE_ARCHITECTURE.md`.
