# Historical sizing comparison

Status: owner-approved diagnostic comparison, 2026-09-20.

Why: separate position sizing from selection and partial-exit effects.
Who: owner evaluating US and India portfolios independently.
Expected benefit: auditable capital-allocation evidence; no promised return uplift.
Implementation verified locally: 2026-09-21 (17 focused tests; TypeScript clean).
Historical portfolio comparison: not yet available; see DATA_READINESS.md.

## First comparison

Implement a pure, network-free replay with one chronological evidence tape shared
by two arms: equal allocation per new entry versus equal planned stop risk.
Initial diagnostic parameters are explicit inputs, not trading defaults. Do not
optimize them on the outcomes. Replay realized entry opportunities and freeze their
exit timestamps, prices and fractions of the original lot. This conditions on what
the app actually bought; it cannot assess missed opportunities or claim a globally
optimal portfolio. Group partial exits under the original entry ID.

Both arms start with identical cash, no positions and the same market/currency.
NAV includes cash and contemporaneously available marks. Explicit mark events
must precede sizing; stale/missing marks invalidate the paired run. Entries have
fixed name, sector and gross exposure caps. Cash may never become negative.
US quantities use six decimals, India quantities use whole shares. Exit fractions
apply to the original simulated quantity, with the final exit clearing rounding
residue. Do not fabricate a liquidation for positions still open at the cutoff.

The plan explicitly declares execution-cost basis points and maximum mark age.
Historical prices that already include spread must not have that spread charged
again. Validate cost provenance before interpreting net returns. NAV drawdown is
measured only at supplied observations and must be labeled sampled drawdown.

## Required evidence

- Complete, untainted chronological tape, immutable event IDs and ordering.
- Original stop with evidence timestamp no later than entry; a later trailing
  stop or a closed lot's captured exit stop is not an entry stop.
- Positive finite fill prices, original quantities and sector-at-entry.
- Marks available at each decision and at the common end timestamp.
- Explicit initial cash, costs and common cutoff; deposits must be represented
  in a future cash-flow-aware extension, not mistaken for performance.

Missing or invalid evidence returns `invalid` with no arm returns. Never silently
drop bad episodes or backfill missing stops from current positions. Historical
snapshots and production ledgers remain untouched. A local CLI consumes an
operator-reviewed JSON fixture; it does not read credentials or call a broker.

## Reporting boundary

Report final NAV, return, cash, gross traded notional, sampled maximum drawdown,
and every accepted/skipped entry. Hash the whole tape and plan. Differences are
conditional diagnostic comparisons, not causal proof, significance, or Upgrade
Path promotion evidence. There is no database writer or trading consumer.

## Separate top-up experiment (pending)

Do not add top-ups to the first comparison. It requires fresh historical research
for held and unheld alternatives, an independently frozen ranking rule, portfolio
constraints and an explicit residual exit policy for newly added lots. Cash is
capacity, not an entry signal. Today's known winners must never choose yesterday's
top-ups. Production anti-pyramiding remains unchanged.

## Acceptance

Tests cover finite cash, concurrent positions, proportional partial exits,
whole/fractional rounding, loss amplification, future-dated stops, stale marks,
invalid exits and identical deterministic runs. Real-data readiness is reported
separately from synthetic test success. No weights, broker caps, or live switches
are changed.
