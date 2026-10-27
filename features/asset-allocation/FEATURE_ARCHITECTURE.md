# Feature Architecture — Asset-Class Allocation

## Owner-requested goal/current portfolio charts — October 27, 2026

Intention/decision: the owner wants to understand the saved intended mix versus
the actual book directly on paper and live portfolio pages. This extends the
approved allocation display; it does not introduce a strategy or new mandate.
Two matching category donuts (Goal, Current) and an accessible percentage-point
gap table share one taxonomy/colors, with all eight targets shown including zero
silver/oil targets. Place beneath paper's symbol Allocation chart, and after the
performance chart on both live market views. Stack charts on narrow screens.

Reuse saved paper policy through the existing owner-only risk-profile GET. A
policy-only read skips unrelated paper book reads. Goals are revision-labelled,
link to Settings Trading, and explicitly inactive when disabled. Live goals are
reference-only: these saved paper targets do not govern or rebalance live orders.
No default silently replaces failed/malformed settings, and stale in-flight
market responses cannot replace the selected market. Hide owner fetches in the
public viewer surface.

Paper current mix uses that displayed market's marked positions and cash. US
live uses selected current broker snapshots with their own marks, not cost basis,
buying power or a USD/INR sum. Deduplicate account snapshots, exclude simulated
and foreign-market books, expose the oldest source time and partial selection
issues. Unverified residual NAV is a separate gray balance, never claimed as
cash. Unknown instrument values remain an explicit unclassified slice; missing
marks, short positions, invalid balances or unreconciled totals withhold the
current donut rather than normalize bad inputs into a plausible allocation.
India uses the existing delivery-plus-margin comparison basis, with margin
balance explicitly unverified rather than claimed as cash; exclude Coin mutual
funds and same-day position rows and state that scope. Unavailable Kite data stays
unavailable. Zero capital displays no current pie. No model/provider calls,
schedules, schema, policy mutation, broker refresh or trading side effects.

Files: shared read-only allocation comparison model and chart component;
PortfolioPage, LivePortfolioPage, IndiaLivePanel; existing risk-profile GET;
focused numerical/scope/read-contract tests and this architecture/work log.
Acceptance: same colors/labels, correct category percentages and gap direction,
shared cash/leveraged budget without double counting, market/account isolation,
transparent missing/stale/unknown states, policy error/retry and market-race
handling, mobile/desktop layout, actual owner browser/API verification, mainline
and READY release. User's explicit request authorizes this display-only scope.

Kite's `net` includes ad-hoc margin and collateral, while cash fields are
separate; it must not be relabelled as verified cash in this chart. Source:
https://kite.trade/docs/connect/v3/user/#funds-and-margins . Unclassified balances
produce lower-bound category shares and withheld gaps, rather than false precise
differences. This display does not repair or change existing account NAV records.

The Robinhood snapshot refresher had omitted `position_count` while replacing
its holdings array. The existing fresh-capture upsert now stores the count from
that same holdings array, matching registry/Alpaca writers. Failed captures
preserve prior data. No existing snapshot is patched by hand; count-mismatched
current charts remain withheld until a successful natural capture replaces them.

## Owner-approved profile implementation — October 26, 2026

The owner explicitly requested editable allocation fixes and reset defaults for
balanced, growth and aggressive plans in both pipelines. Extend the existing
allocation module/settings rather than add an optimizer or shadow. Static
market-local strategic targets do not assert a macro regime. The older
regime-dependent allocator below remains independent and may only tighten limits.

### Contract and defaults

Versioned profiles: conservative, balanced, growth, aggressive. Targets sum to
100% across broad equity ETFs, individual equities, sector/thematic ETFs, bonds,
gold bullion, silver bullion, oil/commodity funds and tactical cash. Gold miners
and energy-sector equities remain equities, not bullion or spot oil. Tactical
cash includes idle cash plus the dedicated leveraged sleeve; the leveraged
maximum is a separate operating sublimit, never another additive allocation.
US maximum stays 5%; India stays 0. Defaults use no oil or silver allocation.

| Profile | Broad ETFs | Stocks | Sector/theme | Bonds | Gold | Tactical cash | US leveraged sublimit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Conservative | 30 | 5 | 0 | 50 | 10 | 5 | 0 |
| Balanced | 40 | 15 | 5 | 25 | 10 | 5 | 0 |
| Growth | 40 | 35 | 5 | 5 | 10 | 5 | 5 |
| Aggressive | 40 | 40 | 10 | 0 | 5 | 5 | 5 |

India uses the same broad risk budgets with no leveraged execution. Local
instrument candidates differ; never cross USD/INR books. These exact weights are
transparent engineering starting points, not optimized or proven alpha. Match
the existing risk profile for the initial paper default (currently aggressive),
with no change to score weights, stops, horizon or kill switches. All defaults
fit the eight-name/20%-per-name arithmetic with sensible fund combinations;
smaller owner name caps, absent eligible funds or stricter risk caps can leave
more cash and must be disclosed. Eight names are a ceiling, not forced fills.

### Storage and owner UI

Reuse `app_settings` text JSON keys `paper_allocation:us` and
`paper_allocation:india`. One record contains preset version, selected profile,
validated targets, leverage sublimit, enabled flag, revision and bounded recent
configuration history. Save uses optimistic comparison of the prior raw value;
reject stale revisions with 409. Missing rows use explicit version-zero defaults;
query/malformed saved-record errors remain unavailable rather than silently
reverting to looser defaults. No schema or new route is required. Extend the
owner-only `/api/settings/risk-profile` section `allocation`; do not mix an
allocation save with broker/risk mutations. Existing risk settings stay intact.

Settings → Trading displays a dedicated market-local allocation panel, profile
selector, editable percentages, current/target/gap table, total validation,
leverage sublimit, version, source evidence links and limitations. Save and
Reset & save defaults persist to the selected market only. Reset touches no
credentials, broker activation, risk weights, other market or historical records.

### Paper entry use and boundaries

Load policy once per paper run. Reuse instrument taxonomy to classify the book;
unclassified funds and invalid marks cannot count as zero exposure. Size new
entries/top-ups down to the selected bucket's remaining target budget before the
existing constructor, cash, sector, name, daily/order and protection gates.
Persist exact policy identity and bucket arithmetic in existing stage/mandate
evidence. Rotation recomputes budget after removing the proposed source, so a
full bucket can replace one of its own holdings. Selling another bucket does
not create additional room in an already full candidate bucket. Existing
rotation prerequisites still apply. These are prospective target budgets, not a new promise
of optimal rebalancing or transaction-level hard risk limits. Existing pool-locked
reserve, name, sleeve and execution controls remain authoritative.

Dedicated leveraged doors monitor existing positions first and apply the
profile's operating sublimit only to new entries, within the existing combined
5% cap and 0.5% minimum. No live allocation/activation or forced rebalancer is
introduced. The app exposes current-versus-target differences; it must not claim
that setting targets has already transformed today's fully invested holdings.

### Evidence and validation

Bounded research admission reuses the existing candidate queue/caps: at most
two underweight allocation funds per market/run, with provenance and no extra
schedule or inference budget. Explicitly disabled watchlist symbols remain
excluded. A target does not authorize a purchase without normal research.

Migration plan: amend the existing shared leveraged paper admission guard after
its portfolio row lock to read the selected saved US sublimit. Preserve its
signature, access grants, original 5% hard check and all other gates. Missing
records retain the original ceiling; corrupt records fail closed. Test the
actual routine on isolated PostgreSQL with synthetic rows, including repeat
migration application and 0%, 2%, disabled-policy and malformed-record cases.
No tables, columns or expanded access are introduced.

Vanguard's historical allocation research supports stock/bond risk tradeoffs,
not unconditional equity-index outperformance. World Gold Council's 2026 India
analysis reports risk-adjusted/drawdown benefit for 7.5–15% hypothetical gold;
it is industry-sponsored, not independent proof for these exact presets.
Devanathan/Tzikas/Boyd (2026), arXiv:2609.07946, provides open-source monthly
stock/bond/gold evidence for volatility control/optimization, chiefly against
60/40 and 50/30/20; it is a recent preprint, not proof the app beats S&P/NIFTY.
SEC/Direxion identify daily reset/path dependence: leveraged funds are tactical,
not a permanent core allocation. India issuer multi-asset products corroborate
investability but are not a matched net-return backtest for Kairos.

Test invalid totals/NaN/unknown fields, shared tactical double-counting, India
isolation, scaled NAV, save conflicts, permission failures, reset persistence,
classification of miners/energy/bullion/bonds, future-entry sizing and existing
gate preservation. Verify both markets in browser and owner-only API behavior,
full tests/typecheck/secrets, exact main SHA and production READY.

> Status: **Deterministic CORE built + SHIPPED OFF (migration 175).** Genome
> evolution, the slow rebalancer, sizing wiring, and UI are the validated
> follow-up. Owner defaults chosen (below) — change any and say so.
> Last updated: 2026-07-13

## Built (2026-07-13, ships OFF)
- Migration 175: `strategy_sleeves(market, sleeve, target_pct, min_pct, max_pct,
  instruments, enabled)` seeded per market + `strategy_config.allocation_enabled`
  (default **false** → allocator inert; zero behaviour change today).
- `lib/allocation/allocator.ts`: deterministic `allocate(sleeves, regime)` — tilts
  targets by macro regime WITHIN hard bands, drops disabled sleeves, renormalizes
  to 100%. `computeAllocation(svc, market)` returns null unless enabled. NO LLM.
  Unit-tested (`tests/allocator.test.ts`).
- **Default decisions used** (owner-tunable in `strategy_sleeves`):
  - US: equity 70% (0–90), defensive_etf 20% (0–50, SHY/IEF/TLT/GLD), cash 10% (5–100), leveraged **OFF** (0–15).
  - India: equity 70%, defensive_etf 20% (LIQUIDBEES.NS/GOLDBEES.NS), cash 10%.
  - Leveraged sleeve **disabled**; rebalance cadence weekly / 5% deadband (documented; rebalancer not built yet).

## Follow-up (NOT built — money path + evolution)
1. Wire the equity-sleeve target into paper-trade sizing (only when enabled).
2. Slow rebalancer for defensive/cash sleeves (weekly cron, deadband).
3. Genome `allocation` block + LearnerAgent proposal + Validation gate.
4. Allocation UI (current vs target per sleeve).
Turn it on with `allocation_enabled=true` only after 1–3 land + are validated.

---

## Original proposal (retained)

> Status: **PROPOSAL — not built.** Needs owner approval before implementation.
> Last updated: 2026-07-13

## Problem

Today the book is **long-only single-name equities + a few ETFs** (metals basket,
region ETFs) with **cash** as the residual. There is **no allocation across asset
classes** — no bonds, no defensive/leveraged sleeves, no target weights, no
"hold more cash / bonds when the regime turns risk-off." Sizing is per-position
(Kelly / `position_size_pct`); the learner/genome evolves **scoring weights +
entry/exit/horizon/sizing**, NOT the asset mix. So the portfolio cannot shift its
*shape* to defend or press an edge as markets change — it only picks stocks.

The ask: can the agents figure out a balance across bonds / US ETF / cash /
stocks / leveraged ETF for max gain in any market, and keep evolving it?

## Design (proposed)

A thin **allocation layer ABOVE the existing stock picker** — it never replaces
scoring; it sets how much capital each sleeve gets, and the picker fills the
equity sleeve as it does now.

### 1. Sleeves (per market / currency — never cross-summed)
Define named sleeves with target bands, e.g. (US):
| Sleeve | Instruments | Band |
|---|---|---|
| `equity` | scored single names (current pipeline) | 0–80% |
| `defensive_etf` | bond/treasury ETFs (e.g. SHY/IEF/TLT), gold | 0–50% |
| `cash` | residual | 5–100% |
| `leveraged` | leveraged/inverse ETFs — **OFF by default, hard-capped, opt-in** | 0–15% |

India mirrors with its own instruments (liquid-bond ETFs, GOLDBEES, cash).

### 2. Deterministic allocator (no LLM on the money path)
A pure function `allocate(regime, riskProfile, genome) -> targetWeights` maps the
existing **`macro_regime`** signal + risk profile to sleeve targets within the
bands. Risk-off → more cash/defensive; risk-on → more equity. Deterministic,
auditable, bounded by the bands. (Consistent with the CLAUDE.md rule against
fragile explicit bull/bear *scoring* switches — this governs *allocation*, not
per-name scoring, and stays inside hard bands.)

### 3. Learner evolves the mapping (bounded, validated)
Extend the **genome** with an `allocation` block: the regime→sleeve-target
mapping + band edges. The LearnerAgent proposes challenger allocations; they go
through the **same champion/challenger + Validation Engine gate** (walk-forward,
fail-closed) before a human promotes. So it "figures it out and mutates" — but
only within hard bands, only via validated, owner-promoted challengers. Never
unbounded, never LLM-driven on the money path.

### 4. Execution
The trader/paper-trader sizes new entries against the **equity sleeve's** current
target, not the whole NAV; defensive/cash sleeves are held as ETF/cash positions
rebalanced on a slow cadence (e.g. weekly, with a no-churn deadband) to avoid
overtrading. Kill-switch / drawdown / per-market controls all still apply.

## Safety
- Leveraged sleeve OFF by default, hard-capped, explicit opt-in.
- All targets clamped to bands in code (not just config).
- Rebalance deadband to prevent churn.
- Paper-first; live only after the same gates as today.
- No cross-currency summing; each market allocates its own pool.

## Scope (build order, if approved)
1. Migration: `strategy_sleeves` (targets/bands per market) + genome `allocation` block.
2. `lib/allocation/allocator.ts` — deterministic `allocate()` + band clamp + tests.
3. Wire equity-sleeve sizing into paper-trade/trader.
4. Slow rebalancer for defensive/cash sleeves (cron, deadband).
5. Genome extension + LearnerAgent proposal + Validation gate + backtest.
6. UI: allocation panel (current vs target per sleeve); docs (arch-08/09 + system-map).

## Open questions for the owner
- Which bond/defensive instruments per market? (US: SHY/IEF/TLT/GLD? India: liquid-bond ETF + GOLDBEES?)
- Enable the leveraged sleeve at all, or leave it off?
- Rebalance cadence + deadband tolerance.
- Paper-only first (recommended) before any live allocation.
