# Known-Anomaly Research Backlog

> Status: **REVIEWED DESIGN DRAFT. NOT APPROVED FOR IMPLEMENTATION.**
> Last reviewed: 2026-07-15 by Codex.
> Scope: measure-only anomaly research. No score, rank, sizing, order, or exit effect.
> Market applicability: US feasibility first. India is unavailable until an
> independently validated point-in-time event and expectation contract exists.

## 1. Decision

Do not begin by implementing PEAD as a scored feature. Begin with a bounded US
data-feasibility study. Kairos currently stores upcoming earnings estimates, but
the refresh path writes `eps_actual = null`; Webull supplies a current consensus
snapshot, not a durable pre-announcement estimate history. The app therefore
does not yet possess the point-in-time actual/expectation pair required for PEAD
or the vintages required for revision momentum.

This backlog is subordinate to `features/advanced-learning` and the existing
Edge/Validation governance. Each distinct signal definition is a separate trial
and counts toward multiple-testing controls. A combined signal is another trial,
not a free improvement.

## 2. Non-Negotiable Invariants

1. No LLM output changes a deterministic score, eligibility result, size, order,
   stop, target, or exit.
2. Every feature is point-in-time: `available_at <= decision_at`. Event date alone
   is insufficient.
3. US and India are evaluated separately. Currency and return pools never mix.
4. A negative observation is measurement only. It cannot enter downside hedging,
   suppress candidates, or create a short without a separately approved feature.
5. Promotion defaults to no change and uses the existing Challenger, validation,
   lineage, and Performance Truth layers.
6. Data comes through the Canonical Evidence Router and existing evidence
   provenance. Do not create an anomaly-specific provider or truth layer.
7. The existing `post_earnings_drift` archetype is not evidence that PEAD exists:
   it currently reacts to pre-earnings proximity and reweights existing dimensions.
   A true PEAD edge must use a different versioned identifier until that naming
   collision is resolved.

## 3. P0: US PEAD Data Feasibility

### Required event record

For each issuer/reporting period, the immutable event snapshot must contain:

- canonical symbol and issuer identity;
- fiscal period and period end;
- announcement timestamp and session (`before_open`, `during_session`,
  `after_close`, or `unknown`);
- first-reported actual EPS, basis, currency, source, and `available_at`;
- last valid consensus EPS strictly before the announcement, snapshot timestamp,
  contributing analyst count, basis, currency, and source;
- later correction/restatement links without overwriting the original value;
- split/corporate-action adjustment metadata; and
- Router policy version and evidence-record references.

Unknown announcement session, incompatible EPS bases, a post-release estimate,
zero/near-zero scaling denominator, or missing provenance causes abstention.

### Candidate surprise definitions

Pre-register and evaluate separately:

1. `pead_analyst_price_scaled_v1 = (actual_eps - consensus_eps) / pre_event_price`.
2. `pead_analyst_abs_scaled_v1 = (actual_eps - consensus_eps) /
   max(abs(consensus_eps), epsilon)`, with a documented epsilon and winsorization.
3. A time-series SUE only after a restatement-safe historical EPS series exists;
   scale the unexpected change by its own historical variability.

Do **not** divide surprise by analyst dispersion. Dispersion measures disagreement,
may be absent or near zero, and can create unbounded values. It may be tested as a
separate conditioning variable once point-in-time analyst-level coverage exists.

### Feasibility output

P0 produces a coverage report, not `edge_signals`:

- eligible events / all events by year, sector, market-cap bucket, and session;
- consensus age and analyst-count distributions;
- basis/currency conflicts and correction rates;
- source outages and survivorship/delisting coverage; and
- estimated provider call/storage cost.

Proceed only if the owner approves explicit coverage floors after seeing this
report. Do not label PEAD “zero data risk” or “data already available.”

## 4. P1: Measure-Only PEAD Edge

After P0 approval:

1. Freeze the definition, universe, horizon set, cost model, and winsorization.
2. Assign returns from the first tradable session after the verified publication
   time. An after-close result cannot use that same close.
3. Evaluate fixed forward horizons aligned with Kairos styles, with overlapping-
   return robust errors, sector/year breakdowns, event clustering, liquidity,
   delistings, and realistic spread/slippage.
4. Evaluate long-only behavior. Negative-surprise names are an excluded/observed
   cohort, not automatic shorts.
5. Write measure-only edge observations linked to existing decision observations
   and evidence snapshots. Never manufacture a decision observation solely because
   an external event exists.
6. Count every definition, horizon, filter, and combination in the declared trial
   family used by DSR/PBO and promotion review.

Only an approved, out-of-sample Challenger may later consume the edge.

## 5. Deferred Candidates

### Analyst-revision momentum

Blocked until Kairos stores immutable estimate vintages. A current Webull target or
forecast cannot reconstruct revisions. A valid contract needs estimate timestamp,
fiscal period, basis, analyst count, revision breadth, stable analyst universe, and
strict pre-decision availability. Evaluate EPS and target revisions separately.

### Filing-language change (Lazy Prices)

US-only feasibility initially. Use point-in-time EDGAR filings, issuer/form/period
identity, acceptance timestamp, amendment links, section-aware extraction, and a
versioned tokenizer/diff algorithm. Never compare a filing with a later amendment
that was not yet known. Plain deterministic similarity is the first candidate;
embeddings or LLM interpretation require a separate untrusted-compute review.

### PEAD.txt-style textual surprise

This is not generic earnings-call tone. The cited research constructs a numerical
text-based earnings-surprise measure. Reproducing it requires a separately reviewed
document corpus, labels, training/evaluation protocol, and point-in-time controls.
It is not an incremental prose feature for P1.

Short interest, 13F flows, options skew, and seasonality remain intake ideas only.

## 6. Validation And Promotion Gates

- common, point-in-time universe and benchmark;
- market-local net returns after costs;
- walk-forward splits with an untouched final holdout;
- sample floors per year/regime/sector, not only aggregate `N`;
- Newey-West or event-cluster-aware uncertainty where observations overlap;
- declared trial-family count and advanced-learning DSR/PBO controls;
- incremental value over the current champion, not standalone significance;
- stable effect direction and no dependency on one provider/year/sector; and
- owner-approved Challenger promotion. No automatic promotion.

## 7. Build Order

1. Resolve the `post_earnings_drift` naming/semantic collision.
2. Specify and capability-probe a US point-in-time earnings contract.
3. Run P0 coverage only; retain no scoring effect.
4. If approved, add immutable event snapshots through Router provenance.
5. Build one pre-registered PEAD definition and evaluation.
6. Add other definitions one at a time as counted trials.
7. Consider revision momentum, filing changes, and India only after their own
   evidence contracts pass feasibility.

## 8. Acceptance And Rollback

P0 passes when every reported numerator/denominator is reproducible from immutable
source references and no post-event fact enters a pre-event snapshot. P1 passes only
when reruns from the same snapshot produce byte-equivalent feature values and the
edge remains measure-only. Disable by stopping new edge computation; immutable
history remains. No positions, signals, policies, or orders require rollback.

## 8b. Implementation Note — Data Capture Enabler (2026-07-15)

Build-order steps 1–2 (plus the vintage table and a feasibility read) are
implemented as **data capture only**. No scored feature, no `edge_signals`, no
scoring/sizing/order/exit effect exists. Deterministic; no LLM.

- **Naming collision (step 1) resolved.** `lib/scoring/archetypes.ts`: the
  archetype formerly `id: "post_earnings_drift"` / label "Post-Earnings Drift"
  is renamed to `id: "pre_earnings_proximity_reweight_v1"` / "Pre-Earnings
  Proximity Reweight". Behavior (weights, `daysToEarnings <= 10` routing, shadow
  role) is unchanged — only the identifier/label/comment. The `pead_*` namespace
  is now reserved for a future true surprise-based edge. Historical
  `shadow_decisions.setup_type = 'post_earnings_drift'` rows remain queryable
  under the old string; the rename starts a new series going forward.
- **First-observed provider actuals (step 2).** Migration
  `20260715210000_earnings_pit_actual_capture_columns.sql` adds
  `eps_actual_first`, `revenue_actual_first`, `actual_available_at`,
  `announcement_session`, `eps_basis`, `actual_currency`, `actual_source`,
  `restated_eps`, `restated_available_at`, `restated_source`, `market` to
  `earnings_calendar`. `lib/data/earnings-pit.ts` fills `eps_actual_first`
  **once** and never overwrites it; migration `20260715220000_...` enforces that
  immutability in Postgres. A later differing provider print is logged to
  `restated_eps`. This is the first value Kairos observed, not proof that a sparse
  polling cadence captured the issuer's literal first print. Source: Finnhub earnings calendar (free, no daily cap, already
  wired); its `hour` field maps to the announcement session.
- **Consensus vintages (step 3).** Append-only table
  `earnings_consensus_snapshots` (migration `20260715210100_...`) accumulates the
  last-valid pre-announcement consensus. A new vintage is appended only when the
  consensus changes since the last snapshot; a database trigger blocks UPDATE/
  DELETE. The conservative timestamp rule rejects consensus captured on or after
  the US report date, preventing delayed actual publication from creating
  look-ahead. `analyst_count` is null on the free
  Finnhub calendar (surfaced in the coverage report). Finnhub also does not
  identify GAAP versus adjusted EPS, so provider identity is never treated as
  accounting basis; these observations remain measurement-only and ineligible
  until another source proves basis comparability.
- **Feasibility read (§3).** `GET /api/calendar/earnings/coverage`, owner-gated
  (`requireOwner`), read-only. Reports eligible events (both a first-reported
  actual AND a pre-announcement consensus vintage with explicitly matching
  basis/currency) by year and session, plus
  analyst-count coverage, corrections, and basis conflicts. It is a coverage
  report, not `edge_signals`.
- **Cadence.** `kairos-earnings-pit-capture` invokes `POST /api/calendar/earnings/refresh`
  daily at 02:10 UTC; the capture runs after the cache bust, fail-soft. RLS is on for both tables (authenticated-read,
  service-role-write), verified via `information_schema` + `pg_policies`.

## 9. Primary Research References

- Bernard and Thomas, post-earnings-announcement drift:
  https://www.jstor.org/stable/2491062
- Philadelphia Fed, PEAD.txt project and revisions:
  https://www.philadelphiafed.org/the-economy/banking-and-financial-markets/pead-txt-post-earnings-announcement-drift-using-text
- Cohen, Malloy, and Nguyen, Lazy Prices:
  https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12885

## 10. Owner Decisions Before Build

1. Approve P0 as US coverage measurement only.
2. Approve one analyst-surprise definition after the coverage report; do not
   approve a combined definition in advance.
3. Set coverage and sample floors from observed feasibility, not guesses.
4. Keep India blocked until a separate point-in-time data proof exists.
