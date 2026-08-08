# Property Valuation (Phoenix) — Feature Architecture

Status: **DRAFT. Not approved, not implemented, no code written.**
Author: Claude · 2026-08-07
Scope decided by owner: **Phoenix only**, **addresses stay encrypted**.
Parent: `features/property-decision-workspace/FEATURE_ARCHITECTURE.md`
Related: `features/walk-forward-ic-folds/` (unresolved false-discovery control),
`features/portfolio-underperformance/DIAGNOSIS.md` (how a confident number gets
retracted).

---

## 1. What this is

Estimate a value range for a specific Phoenix-area parcel, and track how that
range moves, using real recorded sales and real parcel attributes.

**It is a range, never a point.** Section 3 explains why a point estimate would
be a lie regardless of how much engineering goes into it.

Property valuation stays inside the Property workspace and is subject to the same
isolation invariant: **no output reaches any securities score, eligibility gate,
sizing rule, order, exit, promotion gate or broker call.**

---

## 2. Why Phoenix only — the fact that decides the design

**Texas is a non-disclosure state.** Sale prices are not recorded with the county
clerk and are shielded under Tex. Tax Code § 22.27 and Gov't Code § 552.149.
Zillow and Redfin are legally unable to display Texas sale prices at all
([Redfin](https://www.redfin.com/blog/non-disclosure-states-real-estate/),
[NTPTS](https://ntpts.com/non-disclosure-states/)). Travis County's appraisal
district works from voluntary surveys and MLS participation.

So for **Austin there is no public sale price to learn from, at any budget.**
Not "hard to get" — legally unavailable. Any Austin AVM would be fitted to
assessed values, which are themselves a model, and we would be modelling a model.

**Maricopa County (Phoenix) is the opposite**, and free
([Assessor data downloads](https://www.mcassessor.maricopa.gov/page/data_sales/)):

| dataset | contains |
|---|---|
| Sales Affidavits (R102) | parcel number, grantor, grantee, **sale date, sale price** |
| Parcel detail | owner, property address, legal description, legal classification, valuations |
| Residential Master | livable square footage, construction year, residential components |

All pipe-delimited `.txt` inside ZIPs, all free.

Every doc in this repo lists Austin before Phoenix. **On this feature that
ordering is backwards**, and the reason is legal, not technical.

### 2b. Licence constraint — RECORD THIS, it is binding

The Assessor provides the data "with the understanding that such data will
**NOT, under any circumstances, be used or distributed for commercial gain or
profit**."

Kairos Property is a single-owner personal decision-support tool: compatible.
But this **forecloses ever commercialising anything derived from it**, and it
forbids redistribution. If Kairos is ever productised, this dataset must be
removed or relicensed first. That is a product-level constraint, not a footnote.

---

## 3. The accuracy ceiling, measured not assumed

Zillow's published **off-market** median error is **7.06%**; Redfin's is ~6.45%.
On-market is ~1.94%, but that number is not comparable — the list price is an
input to it ([ListWithClever](https://listwithclever.com/real-estate-blog/how-accurate-is-a-zillow-zestimate-5-things-to-know/)).

So the best-funded AVMs in existence, with full MLS feeds and large ML teams, are
**±7% median on a home that is not listed** — ±$35k on a $500k house — and
*median* means half of all estimates are worse than that.

**Design consequence:** this feature reports an interval and an error band, and
the UI never renders a single number as "the value". A point estimate here would
be less accurate than a Zestimate while looking more authoritative.

---

## 4. The measurement problem — the part that constrains everything

A house sells roughly **once every 7–13 years**. A per-address prediction can
only be scored when that address transacts.

The Property workspace already refuses to report a calibration rate below **10
matured outcomes** (`lib/property/calibration.ts`). At address level, ten matured
outcomes for one parcel is a century.

**Therefore the learning loop cannot close at address level.** It closes at ZIP
level, where transactions are frequent. This is not an engineering limitation to
route around; it decides what the system is permitted to claim:

- **ZIP level** — falsifiable. Predict, wait a quarter, score against actual
  recorded sales. Calibration is real.
- **Parcel level** — an *interpolation* of a calibrated ZIP surface using that
  parcel's attributes. It inherits the ZIP's error band. It is **not**
  independently validated and must never be presented as if it were.

---

## 5. What I would refuse to build, and why

The owner asked about news, demographics, new employers, "many many metrics".
Each is individually reasonable and collectively the failure mode.

**A ZIP-wide event cannot rank homes within that ZIP.** A new employer
announcement moves every parcel in the ZIP together, so its cross-sectional
variance within the ZIP is **zero by construction**. That is structurally the
same defect that disqualified NSE FII/DII in
`R3_DIMENSION_FEASIBILITY.md` and that afflicts US `macro_score`. Such a signal
can shift a ZIP's level; it can never tell you which house is mispriced.

**Trial count.** `walk-forward-ic-folds` Open Decision #3 (false-discovery
procedure) is still unresolved. Property offers *quarterly* observations where
equities offer daily. Adding twenty features against less data is precisely how
this codebase produced five confident findings in one week that had to be
retracted (`DIAGNOSIS.md` §4b, §11).

**"Learns user behavior" has n = 1.** This is a single-owner application. There
is no behavioural population to learn from. Dropped.

Deferred, not rejected: ZIP-level covariates (permits, employer announcements,
demographic drift) become admissible **after** stage 2 gives a calibrated
baseline to measure them against — one at a time, each with a pre-declared
hypothesis.

---

## 6. Design

### 6.1 Ingest — bounded external worker, never Vercel

Maricopa bulk files are hundreds of MB. They are fetched, parsed and diffed in a
**GitHub Actions worker**, which then writes normalised rows to Supabase. This
matches the existing decision that Redfin-scale bulk files never enter a Vercel
request.

New tables (all append-only, enforced by trigger **and** revoked grant, per the
lesson in `IMPLEMENTATION_RESULT.md`):

- `property_parcels` — parcel id, ZIP, legal classification, livable sqft, year
  built, lot attributes. **No owner name.** Address stored **encrypted only**.
- `property_sales` — parcel id, sale date, sale price, affidavit provenance.
  This is the ground truth the whole feature rests on.

### 6.2 Repeat-sales ZIP index

Same-parcel resales are the gold standard because the property is its own
control — quality, lot and location cancel out. This is the Case-Shiller
construction. It is also self-calibrating: every resale is a scored observation.

### 6.3 Hedonic surface, ZIP-scoped

A deterministic regression of log price on parcel attributes, fitted **per ZIP**,
producing a value interval per parcel. Attributes are exactly what Maricopa
publishes — sqft, year built, classification. "Corner lot" is only usable if it
is derivable from the legal description or parcel geometry; that is an open
question in §9, not an assumption.

**No LLM touches the estimate.** An LLM may later explain a deterministic output;
it may never alter it. Same rule as the investing side.

### 6.4 Owner's parcel — privacy contract

The owner's address is **encrypted at rest** (`lib/property/crypto.ts`,
AES-256-GCM, fail-closed) and is decrypted only to resolve a **parcel id**. From
that point the pipeline handles the parcel id and ZIP only.

**The model never receives an address.** No owner name, no plaintext address, no
precise identity-bearing record is stored or logged — consistent with the parent
feature contract, which this preserves rather than amends.

---

## 7. Risks

**R1 — a range gets read as a price.** The likeliest harm. Mitigation: no point
estimate is rendered anywhere; the interval and its measured error band are shown
together, always.

**R2 — parcel estimates inherit ZIP error but look bespoke.** A per-parcel number
feels more precise than the ZIP figure it is derived from. Mitigation: label it
as an interpolation and show the ZIP's calibration alongside.

**R3 — the licence.** Non-commercial use only. Any future productisation must
remove this dataset first.

**R4 — assessed-value contamination.** Maricopa's own valuations are a model. If
they leak in as a feature we are fitting a model to a model. Sales only.

**R5 — thin ZIPs.** Some ZIPs will not transact enough to calibrate. They must
report "not enough sales" rather than borrow a neighbouring ZIP's surface — the
same market-local honesty rule that gives Bengaluru zero rows today.

---

## 8. Sequencing

1. Maricopa parcel + sales ingest via GitHub Actions worker. No model.
2. Repeat-sales ZIP index. First falsifiable output.
3. Hedonic surface per ZIP, interval only, scored against subsequent sales, held
   to the existing n≥10 floor.
4. Owner parcel interpolation, clearly labelled as inheriting ZIP error.
5. ZIP-level covariates, one at a time, only after 3 is calibrated.

Stages 1–2 are safe and additive. Stage 3 is the first thing that makes a claim.

---

## 9. Open questions for the owner

1. **Approve stage 1 only?** It is ingest with no model and no claim.
2. **Is "corner lot" actually derivable** from Maricopa's legal description or
   parcel geometry? Unverified. If it is not, the hedonic feature set is limited
   to sqft, year built and classification, and that should be known before
   stage 3 rather than discovered during it.
3. **Non-commercial licence** — accepted as a permanent constraint on this data?
4. **Austin** — accept that it likely never supports valuation, and say so in the
   UI rather than leaving an empty panel implying "coming soon"?
5. **Bengaluru** — Karnataka registration data (Kaveri) is a separate research
   question, not covered here.
