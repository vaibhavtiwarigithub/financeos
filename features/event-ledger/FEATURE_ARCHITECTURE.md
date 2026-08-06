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

### Backfill — done 2026-08-05 (§8 Q3 answered: yes, with cited sources)

`scripts/seed-market-events.ts` — **19 rows, every one carrying a source URL**,
routed through the same validators as `POST /api/events` rather than raw SQL, so
the vocabulary and timestamp guards apply to seeded rows too. Idempotent via the
`(event_type, market, occurred_at)` UNIQUE constraint; a second run inserted 0.

| market | announced | reversed |
|---|---|---|
| us | 7 | 7 |
| india | 3 | 2 |

**Timestamp precision is recorded, not assumed.** Two rows are cited to the hour
(Apr 2 2025 Rose Garden, after the US close; Apr 9 2025 Truth Social, ~13:00 ET
intraday). The rest are date-only and are stamped **23:59:00Z of the event
date** — deliberately, because stamping 00:00Z would place the event up to a day
*before* it became public and a forward return measured from there would quietly
include pre-announcement drift. That is R3 exactly. End-of-day UTC is the
conservative direction: after the US cash close, before the next India open. The
precision marker is written into `notes` so a reader can see which is which.

**No `global` rows.** An event that moved both books is two rows, one per market,
each measurable against its own benchmark. A `global` row would invite a pooled
US+India statistic, and those must never cross-sum.

Every count here is **below the §4.4 floor of 20**, which is the expected and
correct outcome — the base-rate report must refuse to estimate on it.

## 10 — Steps 2 and 3, shipped 2026-08-05

`lib/events/outcomes.ts` (pure), `POST /api/agents/event-maturation`
(`kairos-event-maturation`, weekdays 16:10 UTC, jobid 116), and owner-gated
read-only `GET /api/events/base-rate`.

### The anti-look-ahead rule is the feature

A measurement starts at **the first session whose CLOSE falls after
`occurred_at`**, using a per-market close hour (`us` 20:00Z, `india` 10:00Z).
Anchoring on the close rather than the date is the whole point: an announcement
made at 13:20 ET is tradable at that day's US close, one made after the bell is
not, and starting from a pre-announcement close folds the market's reaction INTO
the "forward" return and makes the pattern look prescient.

Verified against the live ledger, not just fixtures:

| event | market | entry |
|---|---|---|
| 2025-04-09 **17:20Z** (intraday) | us | **2025-04-09** — same session, 13:20 ET is before the close |
| 2025-04-09 **17:20Z** (same instant) | india | **2025-04-11** — after the IST close, and 04-10 was an NSE holiday |
| 2025-02-01 23:59Z (Saturday) | us | 2025-02-03 (Monday) |

An unelapsed horizon returns **null, never 0**. A zero would pull every mean
toward zero while inflating n — the same class as the count-not-span bug this
repo already shipped once in sector returns.

Excursions (MAE/MFE) are measured from `start + 1`, not from the entry bar: we
enter at the entry bar's close, so that bar's intraday range is already past, and
for an intraday-cited event part of it happened *before* the announcement.
**This was a real defect in the first implementation, caught by its own test.**

### Two artefacts found by running it on real data

**`benchmark_neutral_return` is identically 0 for every market-wide event**,
because the subject IS the benchmark. The report initially preferred the neutral
leg, which would have printed every tariff base rate as exactly zero — reading
as a finding and being an artefact. `cohortValue()` now selects raw return for
market-wide cohorts and benchmark-neutral for idiosyncratic ones. An
idiosyncratic outcome without an aligned benchmark is excluded rather than
falling back to raw return; the base-rate response exposes that exclusion count
so an incomplete benchmark series cannot silently shrink or contaminate a cohort.

**`price_cache` cannot mature this ledger**: it reaches back only to 2025-07-22
for SPY, while the earliest recorded event is 2025-02-01. Maturation uses the
repo's existing keyless Yahoo chart source with `adjusted: true` — deliberately
*not* the live scoring path's default, because a return study must not read a
split or distribution as alpha.

### The report refuses

Below `MIN_INSTANCES = 20` the summary carries **nulls, not numbers with a
caveat beside them** — a caveat is something a reader skips; an absent number is
not. `n` is returned either way, and the count of event types tested is returned
with the results per R4.

Live state 2026-08-05: **57 outcomes, 12 cohorts, max n = 7. Nothing estimated.**
Market is part of the grouping KEY, not a filter applied afterwards, so a pooled
US+India row cannot be produced by accident.

### Vocabulary extended — guidance, by owner review

`guidance_cut` / `guidance_raised`, chosen over further macro types **because it
is idiosyncratic**. A market-wide event hits every name in the affected set
together, so its per-date cross-sectional variance is zero by construction: it
can shift a composite's level but never improve its ordering. That is the
measured defect that disqualified NSE FII/DII and that already afflicts US
`macro_score` and `insider_score`. Per-company events are the only ones with real
dispersion, so they are the only ones worth minting.

`EventTypeDefinition.idiosyncratic` drives `requiresSymbol()`: an idiosyncratic
event with no subject has nothing to compute a return ON, so it could never
mature and would sit in the ledger permanently deflating n. `POST /api/events`
rejects it at the door.

**Guidance rows still need a source.** The type exists; populating it is the next
problem, and it is harder than tariffs — per-company, higher frequency, and the
`occurred_at` must be the release or call, not the period covered.

### Not yet built (steps 4-5)

Markets-page display (gated on a type reaching the floor) and any strategy
proposal (gated on §5 in full, including the unresolved false-discovery control).

