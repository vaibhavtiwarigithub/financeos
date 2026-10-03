# Paper Cash Deployment: Soft Reserve, Hard No-Leverage Ceiling

Status: approved by owner on 2026-09-29; implemented and deployed to production in main
commit `a9b8c3abae1b4eb1a4edf031ac6d58af7d30d2e7` (Vercel deployment
`dpl_D3XZ5KminbCmyFTXGxd8XUDXJ4Xh`, READY 2026-09-29). The paper-only cap migration
`20260929215748` is applied. This does not enable or alter live trading.

Implementation status of the 2026-10-01 owner-approved top-up amendment: merged
to `main` as PR #36 (`0f3c51e6`) and deployed READY to production as
`dpl_HVVTG4HvFM5MwmLcAMwwRQTdUgMx` on 2026-10-01. Guarded migration
`20261001190231_qualified_paper_topups` is applied and its service-role-only RPC
grants and once-per-session fill guard were verified in production. The matching
US/India route is active. No forced fills were run; confirm the first normal
market-local paper runs report `cash_deployment` and any qualifying top-up fills.
The production anti-pyramid trigger still rejects ordinary buy-lot inserts into
an open alpha symbol; only the atomic, transaction-local authorization inside
the validated `execute_paper_fill` path can permit a qualified add.

## Why

The owner wants each market-local paper portfolio to keep cash near or below 5%
when suitable candidates exist, rather than leaving large amounts idle solely
because the generic constructor defaults to 80% gross exposure. Cash is a soft
preference, not an instruction to buy weak or stale candidates.

## Policy

- Soft objective: aim for approximately 5% or less cash when eligible entries
  pass all current deterministic checks. Cash may be higher when there are no
  valid opportunities; no buy or sale is triggered merely to meet the objective.
- Paper-only hard gross exposure ceiling: 100% of NAV, which prohibits leverage
  but permits fully invested positions when every other gate passes.
- Keep current per-name, sector, volatility, correlation, score/freshness,
  position-count, sizing, daily-order and portfolio-construction controls.
- The current 12% per-name limit and eight-name limit imply a nominal 96% max
  gross allocation for eight equally capped names (about 4% residual cash).
  Do not raise the per-name cap solely to chase sub-4% cash.
- Keep the shared `max_gross_exposure_pct` field and its 80% fallback unchanged:
  the live portfolio gate also reads it. Live orders, sizing, flags and account
  settings are out of scope.
- Capital rotation may use the paper-only ceiling only after all rotation gates
  independently pass. This policy does not waive its evidence, turnover,
  persistence, cost, tax or post-swap checks.

### Forward paper add-to-winner behavior (owner-approved 2026-10-01)

Fresh deterministic long signals for symbols already held in the same market
are evaluated in a separate, market-local top-up cohort. They do not consume
the new-entry shortlist and do not consume another of the eight name slots.
A top-up is only considered when the fresh signal clears the existing mandate
score/session/data gates and its executable paper fill price is above the
position's current weighted average cost. It may occur at most once per symbol
per market trading session. The existing constructor then sizes only the
incremental amount and enforces the unchanged 12% name, sector, gross, volatility
and stacked-bet limits; available cash, per-order and daily-notional limits also
remain hard caps. An add is never a reason to bypass a failed gate or to invoke
capital rotation.

The top-up creates a separately attributable buy lot and event while the atomic
paper-fill RPC updates the aggregate position quantity and weighted cost basis.
It does not reset or loosen the existing position's stop, target, trailing stop,
mandate or horizon. Direct `paper_trades` inserts remain protected by the
anti-pyramiding trigger; only the validated `execute_paper_fill` transaction can
be reached for an add through the service-role-only `execute_paper_topup` wrapper,
which sets a transaction-local authorization around that fill and independently
checks the current weighted cost. The shared fill RPC enforces the once-per-
session limit under the market-pool lock, including concurrent calls.
The same code path and rules apply to US and India, with market-local currency,
quotes, cash, daily caps, and whole-share/fractional quantity rules preserved.

### Daily-cap downsize (owner-approved 2026-10-03)

An otherwise eligible ordinary paper buy or qualified top-up whose proposed
notional exceeds the *remaining* market-local daily buy allowance may be reduced
to the largest executable quantity at its already validated fill price. This
only reduces the constructor-approved order; it cannot increase the order,
change its symbol or stop/target, trigger rotation, waive a risk gate, or force
deployment toward the soft cash objective. India rounds down to whole shares;
US paper rounds down to six-decimal shares. Zero/invalid allowance, unavailable
market-local session, unreadable buy history, or a remainder below one valid
quantity fails closed. The existing atomic fill RPC independently rechecks the
same daily cap under its market-pool lock, so a concurrent buy can still deny
the resized proposal without creating a partial fill. Log proposed and executed
quantities/notionals and cap context; do not classify a reduced successful fill
as a wholly missed entry. Live and broker execution are out of scope.

The soft 5% cash objective is measured and surfaced in the paper-run summary,
but is not an order instruction. Cash can remain above target because risk room,
sector/name caps, available qualifying signals, fresh quotes, daily limits, or
India's whole-share minimum prevent safe deployment. A candidate's cash need
alone never authorizes a sale; replacements remain subject to the independent
capital-rotation readiness contract.

## Implementation contract

Add `strategy_config.max_gross_exposure_pct_paper`, default 100, bounded to
0–100. The paper trader reads this field for constructor capacity. If the
column is absent during a staged deployment, it falls back to the existing
shared cap/default, so it cannot accidentally loosen behavior before the
migration is available. Live risk code must not read the new field.

## Validation and limitations

Tests must show that paper can use capacity above the old 80% default, remains
under 100%, and still obeys the 12% name / 30% sector / volatility / correlation
and eight-position gates. Additional regressions prove held signals are ranked
separately, profitable-only/session-limited top-ups are selected without
cross-market leakage, direct inserts remain blocked, existing protection is
unchanged, and both market inputs use the same cash/constructor path. Production
cash may remain above 5% if no candidate passes; this is correct abstention, not
a deployment failure. Paired replay is required before claiming that the higher
ceiling or top-ups improve returns or risk.

The database migration must be applied before deploying the code that requests
the new column. Do not apply it directly with ad-hoc SQL; use the repository's
migration pipeline. No production paper configuration should be changed until
the migration and matching application code are deployed together.
