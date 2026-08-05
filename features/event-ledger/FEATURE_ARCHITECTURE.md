# Event Ledger — Feature Architecture

Status: **Step 1 approved and shipped 2026-08-05. Steps 2-5 remain proposals.**
Author: Claude · 2026-08-05
Related: `features/theme-tracking/`, `features/walk-forward-ic-folds/`,
`features/edge-factor-discovery/`, `features/india-scorer-discrimination/R3_DIMENSION_FEASIBILITY.md`.

---

## 1. What this is for

Record dated, typed market events and their observed forward paths, so that
recurring event patterns become a **counted base rate** instead of a remembered
story.

The motivating example is the "TACO" pattern — an aggressive policy announcement
causes a selloff, and the actor has historically reversed within weeks, so the
reaction is fadeable. Whether or not that specific pattern survives contact with
data, the shape is the right one: identifiable trigger → measurable reaction →
conditional forward distribution.

**This proposal builds only the ledger.** It does not build a strategy, a signal,
or a scoring input.

---

## 2. Why a ledger before anything else

Three constraints, all measured in this repo rather than assumed.

**The sample is tiny and will stay tiny.** The motivating pattern has perhaps
5–15 instances. At roughly one event per month, **30 instances is ~2.5 years**.
No amount of engineering shortens that; only recording earlier does.

**A causal story makes a small sample feel decisive.** "We know he backs out" is
exactly the kind of narrative that survives scrutiny it has not earned. This
system already measured **IC ≈ 0 across ~1,700 decision observations** in
`DIAGNOSIS.md` §8 and `R2_TECHNICAL_SATURATION_COUNTERFACTUAL.md` — far more data
than an event pattern will ever have, and it could not separate any variant from
zero. An n≈10 pattern with a compelling explanation is the canonical overfit.

**The false-discovery control does not exist yet.** `walk-forward-ic-folds`
Open Decision #3 (false-discovery procedure) and #4 (cost-adjusted portfolio
test) are both unresolved and both gate steps 8–9 there. Any mechanism that lets
an agent mint and name its own patterns multiplies the trial count — which is
precisely the condition under which that missing control matters most. A ledger
is safe to build now because it makes no claim; a discovery loop is not.

**There is also no event data at all today.** No structured, dated, typed policy
or macro event exists anywhere in the schema. GDELT supplies news volume;
`lib/allocation/international-policy.ts` is portfolio allocation policy, not
political events. Nothing can be measured against nothing.

---

## 3. Scope

**In scope:** an append-only ledger of typed events, their market reaction, and
their matured forward path; plus a read-only base-rate report.

**Out of scope, explicitly:**

- Any scoring dimension. An event is market-wide or sector-wide, so its per-date
  cross-sectional σ within the affected set is zero — the same defect that
  disqualified NSE FII/DII in `R3_DIMENSION_FEASIBILITY.md` and that already
  afflicts US `macro_score` (σ 2.26) and `insider_score` (94.1% at one value).
  It would shift the composite level, not improve ordering, and with **11.6% of
  US rows within ±2 points of the gate** (`DIAGNOSIS.md` §14e) any level shift is
  a threshold change.
- Any entry, exit, sizing, or broker behaviour.
- Automatic strategy generation. `feature_registry` already exists for
  agent-proposed formulas and its lifecycle
  (`proposed → quarantined → measure_only → retired`) deliberately has **no path
  to a scoring state**. That boundary is not relaxed here.

---

## 4. Design

### 4.1 `market_events` — append-only

One row per event occurrence:

- `event_type` — from a **controlled vocabulary**, not free text
  (`policy_tariff_announced`, `policy_tariff_reversed`, `fed_rate_decision`,
  `sanction_announced`, …)
- `occurred_at` — the timestamp the event became public, which is the only
  timestamp that can support a point-in-time claim
- `market` — `us` | `india` | `global`
- `direction` — `escalation` | `de_escalation` | `neutral`
- `magnitude` — nullable, type-specific and documented per type
- `source_url`, `source_name`, `observed_at` — provenance
- `notes` — free text, never parsed

**The controlled vocabulary is the load-bearing choice**, and it is the same
lesson `theme-tracking` produced three days earlier: free-text LLM-minted names
drifted into 42 strings over 13 runs, 32 appearing exactly once, with
"Cybersecurity" arriving as six variants. An event type minted per occurrence
cannot be counted, and counting is the entire purpose.

### 4.2 `market_event_outcomes` — matured forward paths

Per (event, horizon): benchmark return, benchmark-neutral return, max adverse and
favourable excursion. Mirrors `observation_labels`, which already does this for
decisions, so the maturation job and the statistics are the same shape rather
than a second implementation.

### 4.3 Ingest — manual first, deliberately

Events are entered by the owner, or by a narrow adapter against a source with a
**stable timestamped machine-readable contract**. No LLM classifies an event into
a type.

Manual entry sounds weak and is correct here: at ~1 event/month the ingest volume
is trivial, and a hand-entered event with a real `occurred_at` and a cited source
is worth more than an automated one whose timestamp is the moment a news
aggregator noticed it. Look-ahead enters through sloppy timestamps, and this is
the one field the whole feature rests on.

### 4.4 Read-only base-rate report

Per `event_type` × horizon: n, mean and median forward return, hit rate,
dispersion, **and n displayed next to every figure**. Below a declared minimum
(suggest 20) the report states that the sample cannot support an estimate rather
than printing one.

---

## 5. What would make this actionable, and when

Not before all of:

1. ≥20 instances of a single `event_type` with matured outcomes;
2. a stated forward horizon and objective fixed **before** the estimate is read;
3. a false-discovery correction across every event type tested — i.e.
   Open Decision #3 resolved;
4. a cost- and slippage-adjusted result, since fading a reaction trades into
   the widest spreads of the move.

Until then the honest use is a **displayed observation with its instance count**,
informing a human decision. That is genuinely useful at n=10, where a systematic
rule is not.

---

## 6. Risks

**R1 — narrative overrides the count.** The most likely failure is acting at n=8
because the story is good. Mitigation: n printed beside every number; the report
refuses to estimate below the floor.

**R2 — non-stationarity.** A single-actor behavioural pattern works until it does
not, and fading a selloff is short volatility: the failure is large, sudden, and
not helped by a stop. The ledger cannot fix this; any future strategy proposal
must price it explicitly.

**R3 — look-ahead through timestamps.** If `occurred_at` drifts toward "when we
recorded it", every backward measurement is contaminated. Mitigation: separate
`occurred_at` from `observed_at` and treat any row where they are implausibly
close as suspect.

**R4 — event-type proliferation.** Each new type is another trial. Mitigation:
the vocabulary is owner-reviewed, and the count of tested types is reported with
the results.

---

## 7. Sequencing

1. `market_events` + `market_event_outcomes` + controlled vocabulary. No UI, no
   signal. Append-only, RLS, `service_role` INSERT-only.
2. Maturation job reusing the `observation_labels` pattern.
3. Read-only base-rate report with n-floors.
4. Markets-page display, once a type reaches the floor.
5. Any strategy proposal — separate, and gated on §5 in full.

Step 1 is small, additive, and reversible.

---

## 8. Open questions for the owner

1. **Approve step 1?**
2. **Which event types to seed?** Recommend starting with one — the motivating
   policy-reversal pattern — rather than a broad taxonomy. Each extra type is an
   extra trial against an unresolved false-discovery control.
3. **Backfill?** Historical instances could be entered manually with cited
   sources. Worth doing *only* if `occurred_at` can be sourced accurately;
   reconstructing dates from memory would produce exactly the look-ahead in R3.
   Note the precedent: the `theme_observations` backfill three days ago keyed on
   `created_at` and produced misattributed rows, because the underlying table had
   never recorded run identity. A backfill is only as good as the timestamp it
   can cite.

---

## 9. Step 1 — shipped 2026-08-05

`lib/events/vocabulary.ts`, `market_events`, `market_event_outcomes`, and an
owner-gated `GET`/`POST /api/events`. Migration applied and verified.

**Vocabulary seeded with the trade-policy family only** —
`policy_tariff_announced` and `policy_tariff_reversed` — per §8 Q2. The paired
announce/reverse types make the *interval between them* measurable, which is the
quantity the pattern actually claims. Every additional type is another trial
against an unresolved false-discovery correction, so growth is an owner-reviewed
edit rather than a convenience.

**Guards verified against the live database, not assumed.** Two deliberate
violations were attempted and both were rejected, leaving the table empty:

| attempted | result |
|---|---|
| `occurred_at` two days in the future | rejected by `market_events_occurred_before_observed` |
| `market = 'mars'` | rejected by the market CHECK |

Grants confirmed: `market_events` holds `INSERT, REFERENCES, SELECT, TRIGGER` —
no UPDATE, DELETE or TRUNCATE. `market_event_outcomes` additionally keeps UPDATE
so a horizon can be re-matured if a price source is corrected, but never DELETE
or TRUNCATE. Append-only is a grant property, not a writer convention.

**Ingest is manual and owner-gated**, with `source_url` and `source_name`
mandatory. An event with no citation cannot be re-verified, and an unverifiable
`occurred_at` is precisely the look-ahead in R3. The route also fails closed on
an unrecognised `event_type` and returns the known list rather than recording the
string — the theme ledger failure mode, avoided by construction.

`GET` returns ledger contents with per-type counts and an explicit note that **no
base rate is computed there**. A rate requires matured outcomes and the declared
minimum n from §4.4; nothing in step 1 produces one.

### Not yet built (steps 2-5)

The maturation job, the base-rate report with n-floors, any display, and any
strategy proposal. The ledger currently holds **zero rows** — that is the correct
state, and the first real entry is the owner's to make.

