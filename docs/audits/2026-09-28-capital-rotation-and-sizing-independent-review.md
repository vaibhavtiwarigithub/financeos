# Independent review — capital rotation and cash sizing

Date: 2026-09-28. Production reads are read-only. This review changes no
rotation/config flags, orders, positions, risk limits, scores, or broker state.

## Decision summary

Capital rotation is implemented as a deterministic, market-local paper path,
but it is **not currently executing**. Its database paper switches are off and
current P1 evidence is not ready. Keep score/return, cost, turnover, tax-lot,
post-swap risk, correlation, freshness, and atomicity gates intact. A switch
change cannot make the negative/insufficient evidence positive.

Cash sizing is also **not complete** against the requested max-eight names and
≤5% cash goal. The portfolio risk policy presently blocks that utilization:
both market books use an 80% gross-exposure default, mandates allow 15 open
names, and the strategy-specific exposure columns are NULL. There is not enough
validated historical data to claim an optimal per-name size or top-up policy.

## Production snapshot

Rechecked on 2026-09-28 in Supabase project `dionkikgdmlaotvtbnfr`:

| Item | US | India |
|---|---:|---:|
| Paper alpha positions | 13 | 11 |
| Configured `max_open_positions` | 15 | 15 |
| Cash | $3,079.49 | ₹450,825.33 |
| NAV | $9,998.74 | ₹1,056,614.94 |
| Cash/NAV | 30.80% | 42.67% |
| Active `investment_mandates.max_position_pct` | 10% | 10% |
| `turnover_budget_monthly` | 20% | 20% |
| Paper rotation flag | false | false |
| Score-only paper rotation | false | false |
| Live rotation proposals | false | false |
| Rotation events in prior 60 days | 201 | 205 |
| Executed rotations in prior 60 days | 0 | 0 |

`strategy_config.max_gross_exposure_pct`, `max_name_exposure_pct`,
`max_sector_exposure_pct`, `max_portfolio_vol_pct`, and
`max_avg_pairwise_corr` are NULL. This selects constructor defaults in
`lib/portfolio/constructor.ts`: 80% gross, 12% name, 30% sector, 2% daily
portfolio volatility, and 0.7 informational average-pairwise-correlation
bound. The 10% `investment_mandates.max_position_pct` is a separate mandate
input, particularly relevant to rotation sizing; it is not the constructor's
name-cap field.

That distinction matters. Under the current 80% gross cap, even eight names at
12% cannot get the book to 95% invested. Under a 10% per-name mandate, eight
names would allocate at most 80% even before other constraints. The requested
cash ceiling therefore cannot be met without raising applicable risk limits,
which could increase drawdowns and is not justified by “more invested means
more profit.” Cash should be a soft outcome of eligible opportunities and risk
limits, not an order-generation target.

The strategy's normal paper `position_size_pct` is 20%, but constructor limits
can reduce or deny each proposed buy; the constructor never force-sells an
existing position. The current 13/11 holdings exceed the requested eight-name
count, but a one-for-one rotation cannot consolidate the portfolio. That needs
a separate multi-source liquidation/consolidation policy, explicit sell
precedence, tax/lot and cost treatment, and a matched replay before it can be
automated.

## Rotation: exact current blockers

The latest India HDFCBANK.NS → GMMPFAUDLR.NS plan had exact-lot evidence,
post-swap constructor admissibility, complete 14/14 correlation pairs, and
0%-used monthly turnover; the plan proposed about 3.16% turnover. Its remaining
blocker was `score_to_return_mapping_unvalidated`. In the same run, ITC.NS was
also rejected for below-margin score edge and failed persistence. Earlier
India mapping measurement had negative mean edge and 4 effective independent
windows versus the required 20; recalculate before quoting it as current.
Production must not convert NULL expected edge to zero or silently treat
insufficient evidence as a pass.

The last US rotation event is 2026-09-18, versus India 2026-09-28. This is a
market-local freshness question to check at the next US eligible paper-trader
run; it is not enough by itself to call the US collector broken. The deployed
`CAPITAL_ROTATION_PAPER_ENABLED` variable exists in Vercel Production but its
value is hidden/unverified. Do not use the variable's existence as proof that
the route is armed.

The executor's independently enforced gates include a deployment flag, the
market's paper switch, the score-only policy switch, a fresh ready P1 contract,
exact candidate/sized-buy matching, entry policy, run/day/cooldown/persistence
checks, re-evaluated source eligibility, and the atomic RPC. Production DB
switches are currently off. Do not toggle them until the effective deployment
path is verified and the owner-approved P1 contract passes. Keep all live
rotation settings off.

## Sizing evidence status

The equal-weight versus stop-risk offline replay is implemented, but an
inception-to-date comparison is still invalid until original fills/partial lots,
entry-time stop provenance, price history, and a common complete tape are
reconciled. India lacks price history for several traded roots. No synthetic
prices, current stops, or present-day winners may be substituted. The proposed
“maximum gain” is especially vulnerable to look-ahead and survivorship bias.

The separate top-up experiment is not implemented. Correct experiment shape:

1. Freeze at each market-local decision timestamp the complete eligible
   candidate ranking, scored-symbol panel, prices, portfolio state, and
   research/strategy version. Never rank historical top-ups with a later score.
2. Compare identical cash, constraints, evaluation horizon, and price tape for
   **leave cash**, **top up a held eligible name**, and **buy a new eligible
   name**. Use same-session eligible-but-untraded controls.
3. Predeclare risk-based size and residual-lot exit policy for each new/add-on
   lot. Preserve cost basis and partial exits; censor/merge with subsequent real
   fills to avoid counting one market move twice.
4. Include spread/slippage, taxes/fees where applicable, liquidity, sector and
   correlation, turnover, whole/fractional share rounding, deposits/withdrawals,
   drawdown, and matched benchmark results. Report coverage/maturity separately
   from P&L; do not call close-only marks fills.
5. Begin with a prospective shadow cohort if point-in-time historical research
   is unavailable. Do not connect the result to paper/live order sizing until a
   reviewed paired comparison supports it.

## Independent research and design implication

- Moreira and Muir report that reducing exposure when volatility is high can
  help in their studied factor portfolios; that does not imply a universally
  higher return, nor validate Kairos’ limits. A broader real-time evaluation
  finds no systematic out-of-sample Sharpe improvement across 103 strategies
  and warns about structural instability. See [NBER, *Volatility-Managed
  Portfolios*](https://www.nber.org/papers/w22208) and [*On the Performance of
  Volatility-Managed Portfolios*](https://www.sciencedirect.com/science/article/pii/S0304405X2030132X).
- Novy-Marx and Velikov find transaction costs reduce profitability and
  statistical significance; a buy/hold spread is an effective simple cost
  mitigation in their anomaly tests. This supports a no-trade band/persistence
  design, not frequent churn. See [NBER, *A Taxonomy of Anomalies and Their
  Trading Costs*](https://www.nber.org/papers/w20721).
- Korajczyk and Sadka estimate trading costs and find equal-weighted momentum
  can look best before costs and worst after costs; liquidity-weighted choices
  improve capacity. See [Kellogg research summary](https://www.kellogg.northwestern.edu/academics-research/research/detail/2004/are-momentum-profits-robust-to-trading-costs/).
- Tunc and Kozat study threshold rebalancing under explicit model assumptions;
  their result motivates testing cost-aware no-trade thresholds, but does not
  select Kairos’ threshold. See [arXiv paper](https://arxiv.org/abs/1203.4156).
- DeMiguel, Garlappi and Uppal show that estimation error can erase the
  out-of-sample gains of optimized allocations versus simple 1/N across their
  studied datasets. This is a warning against claiming an optimal sizing rule
  from a small, selected trade history. See [Review of Financial Studies DOI
  record](https://doi.org/10.1093/rfs/hhm075).

The relevant synthesis is not “hold more cash” or “be fully invested.” It is:
size to validated loss risk and portfolio constraints; make a swap only when
expected incremental return exceeds transaction/tax cost and estimation
uncertainty; require persistence/no-trade bands to limit churn; and grade the
policy on paired net portfolio results, not sell-leg P&L or score spread alone.

These studies support testing those mechanisms. They do **not** establish a
profitable Kairos policy, a safe 95%-invested target, or readiness to enable
rotation.
