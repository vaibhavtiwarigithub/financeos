# Portfolio allocation profiles — implementation and evidence

The owner requested editable allocation defaults for both markets, including
reset for each plan. This extends the existing allocation architecture and
owner-only Settings → Trading page. It does not activate live trading.

## Why this structure

The current US book is five individual stocks plus JQUA; India has eight
individual equities. Current NAV is approximately $9,802 and ₹992,324. These
books have no bond/bullion allocation. A concentrated equity book can lag an
index even while being nearly fully invested. More sources and larger buys
alone do not solve sector concentration or weak selection.

Diversification changes portfolio variance through both weights and covariance:
`variance = w' Σ w`. Adding an asset helps only when its joint risk/expected
return, costs and opportunity cost justify its weight. Bonds and gold are not
guaranteed hedges in every inflation/rate regime. More individual names inside
an ETF also do not eliminate overlapping exposure to directly held stocks.

[Vanguard's historical mix comparison](https://investor.vanguard.com/investor-resources-education/education/model-portfolio-allocation)
supports the equity/bond risk-return tradeoff. It does not establish a balanced
portfolio as a higher absolute-return alternative to equities in every period.
[Vanguard's allocation framework](https://corporate.vanguard.com/content/dam/corp/research/pdf/the_vanguard_asset_allocation_model_an_investment_solution_for_active_passive_factor_portfolios.pdf)
also distinguishes objectives, constraints and uncertain expected returns.

[World Gold Council's India analysis](https://www.gold.org/goldhub/research/why-gold-2026-anchor-indian-portfolios)
uses hypothetical INR portfolios and supports studying gold for risk-adjusted
returns/drawdown. It is industry-sponsored, not independent validation of our
weights. The [2026 stock/bond/gold preprint](https://arxiv.org/abs/2609.07946)
studies monthly allocation with costs and supplies code; it motivates volatility
awareness, not a claim that these Kairos presets have passed a replicated
out-of-sample benchmark test.

The [SEC daily-reset warning](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/sec)
and [Direxion's description](https://www.direxion.com/education/pursuing-daily-targets-in-volatile-markets)
support keeping leveraged funds tactical and capped, rather than treating them
as permanent diversified core exposure.

## Transparent starting defaults

All percentages below sum to 100. Oil and silver start at zero but have editable
buckets. Their inclusion is optional, not a diversification requirement.

| Plan | Broad equity ETFs | Individual stocks | Sector/theme ETFs | Bonds/liquid | Gold | Tactical cash + leveraged | US leveraged max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Conservative | 30 | 5 | 0 | 50 | 10 | 5 | 0 |
| Balanced | 40 | 15 | 5 | 25 | 10 | 5 | 0 |
| Growth | 40 | 35 | 5 | 5 | 10 | 5 | 5 |
| Aggressive | 40 | 40 | 10 | 0 | 5 | 5 | 5 |

India uses local funds and a zero leveraged limit. Its oil bucket is unavailable
until an approved suitable commodity instrument exists; energy-company shares
are equities. The targets are engineering starting points, not fitted optimal
weights, historical return forecasts or proven S&P/NIFTY beaters. Conservative
India cannot currently fill a 50% bond target using the sole reviewed liquid ETF
under a 20% name cap; the UI discloses this instrument-coverage limitation.
Reviewing additional bond funds is separate from relaxing a concentration cap.

JQUA counts as diversified core for allocation only. Its
[issuer fact sheet](https://am.jpmorgan.com/content/dam/jpm-am-aem/americas/us/en/literature/fact-sheet/etfs/FS-JQUA.PDF)
describes Russell-1000 sector matching with quality selection. This does not
change any research score formula or assume its holdings are independent of
directly owned stocks. Gold miners count as equities; bullion counts as gold.

## Implemented flow

1. Owner chooses the market and plan in Settings → Trading, edits targets and
   saves. Reset & save restores that selected plan's versioned defaults only.
2. Existing `app_settings` stores separate US/India JSON policies, revisions and
   twelve recent configuration snapshots. Compare-and-swap prevents stale saves.
   Invalid/corrupt records fail closed and produce a health issue.
3. Ordinary paper entries/top-ups use remaining bucket capacity before existing
   constructor, quote, cash, name, sector, protection and kill-switch checks.
   A rotation recomputes budget after removing its proposed source. No source
   in a different bucket can create capacity in a full candidate bucket.
4. Dedicated leveraged doors monitor existing holdings first and apply the
   profile's operating sublimit only to new entries. Database migration
   `20261026231841_allocation_profile_leveraged_limit` also checks that sublimit
   after the existing pool lock. Original 5% hard ceiling remains intact.
5. Research admits at most two underweight allocation funds per market/run,
   inside existing candidate budgets, without a new schedule or paid provider.
   Explicitly disabled watchlist symbols stay excluded. Research and eligibility
   are still required; a target does not generate an unconditional order.

Ordinary bucket weights are prospective targets, not a new atomic rebalance
kernel. Concurrent fills, price moves, existing holdings and other gates can
leave differences. The shared leveraged ceiling/reserve and name limits remain
transactional. Targets never force sales or alter historical records. Eight
names remains a ceiling; whole-share rounding and minimum order sizes matter.
The pre-existing live ETF cap is separate and has not been raised.

## Validation and remaining boundaries

Focused tests cover all presets, invalid totals/NaN, classifications, bucket
capacity, post-source swaps, tactical cash accounting, policy persistence,
stale-save conflicts, reset isolation and owner/mixed-mutation API boundaries.
An isolated PostgreSQL drill uses actual routines with synthetic rows and proves
0%, 2%, disabled-policy, corrupt-record and original hard-ceiling behavior;
repeat migration application is idempotent. No production financial writes,
model inference, broker action or trading-cron invocation was used to test.

Production catalog verification: migration recorded; new marker, portfolio lock
and original hard cap present; service-role execution retained; anonymous and
authenticated roles cannot execute the guard; empty search path unchanged.
Full-suite/typecheck/secret scan and exact mainline/READY/browser evidence are
recorded in the work log at release.

The first Vercel build rejected an optional `NextRequest` GET argument. Cached
local route types had not detected this Next.js signature constraint. The fix
uses the required request argument; route/API tests are repeated and Next's
route types regenerated before the follow-up typecheck and deployment. No
failed deployment is counted as production-ready evidence.

Live policy, universal protective-order coverage, retrospective optimized mixes
and a matched US/India total-return allocation replay are not delivered by this
change. The US accuracy brake, missing historical EOD evidence and expired Kite
session remain distinct issues; none is cleared by selecting a profile.
