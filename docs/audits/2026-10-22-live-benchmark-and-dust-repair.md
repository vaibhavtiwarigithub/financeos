# Live benchmark truth and paper dust repair

## Findings

- A production SQQQ lot was opened with sub-cent notional, not left behind by a
  partial exit. The dedicated paper planners accepted every positive cash
  amount. A zero-decimal card then displayed the nonzero holding as zero.
- The independent live chart hard-coded the primary comparator. It could use
  India paper history or a current-holdings US backcast when live observations
  were sparse, normalize the benchmark from another base date and aggregate a
  different set of accounts each day. It also labelled equity changes, including
  unknown deposits/withdrawals/transfers, as portfolio performance/alpha.
- Production India has sparse historical live observations. Missing NAV and
  cash-flow history cannot be recovered by changing a chart or inferring flows
  from equity jumps. No historical values were invented in this repair.

## Implementation

Paper entry policy v2 rejects leveraged orders below 0.5% of NAV after cash,
risk and sleeve reductions; this matches the core viable-position convention,
not a measured optimum. The 5% combined sleeve ceiling remains unchanged.
No order is increased to meet the floor, no source lot is deleted, and no
automatic top-up/cleanup trade is performed. Existing sub-cent holdings display
as less than one cent, with a card explanation. Monetary formatting is shared.

Live charts now reuse the paper comparator component, benchmark registry/table,
paginated observations, saved display selection and exact-session arithmetic.
Both live markets use the same wrapper. Live access remains owner-only despite
the paper endpoint also serving authorised viewers. Empty account selection
means no accounts, not all accounts. A fixed selected account cohort must be
present on every valid session; absent/invalid values cause gaps, never zero
imputation or carry-forward. Missing live observations break the portfolio line.
Benchmark selection never changes portfolio membership or the governed primary.

The live line is explicitly unadjusted account-equity change, not investment
return. No live alpha/outperformance badge is shown. No paper proxy, current-
holdings backcast, primary-only snapshot benchmark or browser-triggered provider
history fetch remains in the live chart. No new API, schema, schedule, provider,
score formula, broker order path, live lease or enablement was added.

## Local verification

- Full suite: 4,266 passed, eight skipped, zero failures; 517 passing files plus
  one skipped. Follow-up focused tests passed after using synthetic-only amounts
  in fixtures. No real account identifiers, balances or secrets are fixtures.
- Actual route tests cover owner/viewer boundaries before service reads, market/
  book validation, exact comparator selection, empty account selection, database
  failure, absent India history and isolated saved live preference keys.
- Cohort tests cover new/missing accounts, currency/legacy-market scope, invalid
  versus genuine zero balances, duplicate snapshots and missing chart sessions.
- All four paper planners reject dust; exact minimum/capacity boundaries and
  sub-cent formatting are tested. Existing sleeve clamp tests now use a viable
  boundary, rather than requiring an order below the newly declared minimum.
- TypeScript and the 78-page production scratch build passed. Generated scratch
  references are restored before release. Secret scan/deployment/browser results
  are recorded after the release checks finish.

## Boundaries

No real order, historical lot mutation, manual trading cron, synthetic model call
or broker sync is used for QA. The existing SQQQ dust lot remains in the ledger
and normal monitoring; only new dust entries are prevented. Live cash-flow-
adjusted investment returns remain unavailable pending verified flow and
valuation history. Sparse/stale Kite history also requires successful future
authenticated captures; no chart can recreate unrecorded historical balances.
Desktop browser verification does not imply mobile/cross-browser coverage.
