# Production evidence audit — 2026-09-20

Read-only FinanceOS queries; paper marks and NAV latest through 2026-09-18.
No trading or database data changed. These are app-ledger observations, not an
independent validation of historical market prices.

| Evidence | US | India |
|---|---:|---:|
| Trade lots, including partial residuals and open lots | 108 | 153 |
| Lots missing `paper_trades.stop_loss` | 83 | 107 |
| Tainted or excluded lots | 25 | 0 |
| First purchase | 2026-07-09 | 2026-07-07 |
| First persisted position-mark session | 2026-08-17 | 2026-08-17 |
| Position-mark rows | 267 | 285 |
| Rows marked stale | 20 | 51 |
| Distinct position-mark sessions | 23 | 23 |

`stop_loss` presence does NOT prove entry-stop provenance: the closed-lot
capture can record a later stop. Current `paper_positions.stop_loss` is explicitly
not a historical substitute. These counts describe column coverage only,
not an assertion that the remaining 25 US / 46 India lots can be replayed.

## Alternate entry-stop evidence

Pre-fill `pipeline_stage_events` risk-plan payloads contain timestamped stops.
Matching signal, market, symbol, a preceding ten-minute window and fill price
within 0.0001 yielded **82 US / 127 India lots** with candidate original-stop
evidence. Of those, **57 US / 81 India** had no captured lot stop. The stricter
fill-price check reduces US matches from the initial broad match of 94 to 82.
These are lot counts, not independent entries or approved replay observations;
taint and partial-lot lineage still need reconciliation.

`recover-entry-stops.sql` preserves matched source IDs and timestamps and retains
unmatched lots explicitly. It is read-only, with a frozen September 19 UTC cutoff.
It must not be used to overwrite historical rows. Coverage alone does not verify
the stop was accepted by execution, resolve multiple attempted fills, or supply
the missing July marks.

Local verification: 17 focused tests passed and TypeScript passed. The CLI test
uses a clearly labelled synthetic fixture, not historical portfolio evidence.

## Status and next safe actions

The offline two-arm engine and CLI are implemented. The full-inception empirical
comparison is **blocked on evidence reconstruction**; no return improvement is
reported. Top-up simulation is **not implemented**, pending a separate frozen
experiment and historical holding/candidate research.

1. Resolve original entries and partial exits by immutable lot/event lineage;
   reconcile cash and quantities to the recorded book, including tainted episodes.
2. Recover entry-time stops from timestamped original decision/execution payloads.
   Missing values remain missing; do not synthesize from current stops or returns.
3. Recover mark history from verified point-in-time prices with corporate-action
   treatment. August-onward marks alone cannot describe July portfolio risk.
4. Freeze one common clean window and complete opportunity tape before computing
   either arm. Do not select the window because its result is attractive.
5. Declare capital, caps, mark-age policy and additional transaction costs before
   running. Validate filled prices already include which costs to avoid double-counting.
6. Run `node scripts/replay-portfolio-sizing.mjs <reviewed-input.json>`. The JSON
   contains `plan` and chronological `tape` following `lib/replay/portfolio-sizing.ts`.
   Exit code 2 means invalid evidence and both arm returns are null.

No result from this conditional held-name experiment alone establishes causal
Upgrade Path attribution, statistically validated sizing, or a live-trading policy.
