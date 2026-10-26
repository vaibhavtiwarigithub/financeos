# Discovery and execution clarity

Owner instruction: October 26, 2026, reassess the discussed plan and go ahead.
Status: implementation of bounded discovery and operational evidence; strategy
challengers and universal live protection remain explicitly separate.

## Decision

Reuse the existing deterministic screens, retained-candidate queue, provider
cache/pacing, research journal, four leveraged paper planners and agent run ledger.
The October 26 SOXL audit found daily research 41/100 and h10 council 40/100;
intraday confirmation eventually passed but 55 runs rejected sizing without
preserving the capacity breakdown. Adding VIX cannot repair missing funding or
prove an earlier entry would win. Do not fit new rules to this one rally.

## Implement now

1. Persist exact available/minimum notional and shortfall from the existing shared
   minimum-size check. All four paper routes retain setup, timestamped quote,
   research identity and the account cash/NAV snapshot when a planner rejects.
   Preserve reasons and limits; no replacement trade or forced sale.
2. Extend the existing Research journal with the latest same-day leveraged paper
   decision for each symbol. Join only decisions available by the view's chosen
   time/date; never claim a daily score predicted the later session. State that
   the council is an h10 shadow and intraday confirmation is a separate contract.
3. Add bounded US activity discovery from Alpaca most-actives and gainers using
   the existing complete credential-pair resolver and provider cache/pacing.
   Verify endpoint access before claiming it works. Unconnected remains optional;
   configured failure is visible in System Health, with no paid upgrade.
4. Activity lists are discovery only: filter symbols, positive price/liquidity
   evidence where supplied, deduplicate, retain source/as-of facts and admit at
   most two through the existing US discovery reserve/candidate-cap machinery. Do not require
   an activity candidate to meet the value screen. Do not increase LLM/council
   daily budgets or introduce new research schedules.
5. Reuse the existing “Why it appeared” provenance UI; identify fundamental
   growth versus price activity and distinguish provider event time from fetch
   time. Premarket movers are previous-session results, not current-session
   breakouts. Reject stale/future or unverifiable session payloads.

Regular-session requests only: premarket research skips this lane and continues
the existing fundamental, benchmark and retained-candidate lanes. Stable
round-robin admission prevents one discovery lane consuming the entire reserve.
Existing discovery-only cap exemptions remain; at most two activity names can
join those runs, within the same wall-clock allowance and model budget. This is
not a promise that every run researches an unchanged total number of symbols.
The journal's later operational reading is explicitly separate from facts known
when the earlier research was written.

No new schema, API route, paid service, broker credential or execution permission.
Alpaca screens are SIP-based discovery; existing IEX bars remain partial-venue
intraday evidence. A screener success does not establish SIP quote entitlement.

## Research and methodological reassessment

- Gao, Han, Li and Zhou, *Market intraday momentum* (JFE 2018): the market's
  opening half-hour predicts its final half-hour in that study; it does not prove
  an early SOXL reversal strategy. DOI: 10.1016/j.jfineco.2018.05.009.
- Daniel and Moskowitz, *Momentum Crashes*: sharp rebounds can hurt trend-based
  rankings after declines; this motivates testing a separate conditional rebound
  hypothesis, not automatically buying every oversold ETF.
  https://www.nber.org/papers/w20439
- Bailey et al., *The Probability of Backtest Overfitting*: disclose trial counts,
  use chronological held-out data and avoid choosing a variant from today's move.
  https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf
- Cboe: VIX is non-directional expected 30-day SPX volatility. Treat a future
  VIX/VXN input as risk context pending source/horizon-matched validation.
  https://www.cboe.com/insights/posts/what-the-vix-and-vix-1-d-indices-attempt-to-measure-and-how-they-differ/
- Official Alpaca screening contracts:
  https://docs.alpaca.markets/us/reference/mostactives-1
  https://docs.alpaca.markets/us/reference/movers-1

Practitioner accounts are idea sources, not verified net-return evidence. Prefer
point-in-time prices, reproducible rules, fees, spread, gaps, false entries and
missed recoveries over screenshot returns or an indicator's reputation.

## Consolidated remaining queue and gates

| Priority | Work | Required evidence or next action |
| --- | --- | --- |
| Safety/data | Missing sources, closing marks, Guardian source truth | Repair reproducible producers; never invent historical financial records or clear unverified health |
| Operational | Exact funding rejection and separate horizons | Implement now using existing ledgers/UI; verify next natural run |
| Discovery | Activity, fundamentals, benchmark constituents, retained candidates | Existing caps and market boundaries; no all-universe LLM research promise |
| Allocation | Funding qualified leveraged setups from invested capital | Design paired incumbent-versus-funded portfolio replay with costs, sale selection, turnover, tax lots, sleeve/sector/opposing exposure and atomic execution; no automatic forced liquidation in this slice |
| Strategy | Earlier rebound entry, VIX/VXN, sector breadth/catalysts | One bounded preregistered challenger, time-ordered out-of-sample and then forward evidence; all failures and opportunity costs included |
| Research accuracy | Formula/council/strategy comparisons | Existing exact-version, cohort/horizon evaluators; immature/negative evidence stays insufficient |
| Guardian/live | India full workflow, Webull/Alpaca stop parity, adaptive recovery | Account-specific capital/loss/duration mandate and protective lifecycle; primary Robinhood excluded |
| Performance | True live return comparisons | Verified cash-flow and valuation history; current chart is equity change |

Existing retained candidates, India technical/value screens, benchmark constituent
coverage and MACD versions are reused, not rebuilt. Source recovery, account login,
and paired attribution programs are not called completed by these code changes.

## Verification and rollout

### Full-fix continuation: prospective operating liquidity

Owner requested the full fix after the first release. The simpler funding path
is to reserve the unused portion of the already approved 5%-NAV leveraged sleeve
inside US paper cash, rather than invent a cross-horizon forced-sale strategy.
Why: ordinary buys consumed essentially all cash before an otherwise qualified
setup. Who: the owner's US paper book. Expected benefit: executable funding
availability, with explicit possible cash drag and no return promise.

For each ordinary entry/top-up, reuse the current book and NAV: reserved cash is
`max(0, 5% * NAV - current combined leveraged market value)` and ordinary
deployable cash is `max(0, cash - reserved cash)`. The full-book gross ceiling
becomes `min(existing gross ceiling, 95% + leveraged gross weight)`. Thus the
ordinary sleeve cannot consume its counterpart's budget, and invested leveraged
capital is not reserved a second time. This only tightens existing limits. No
forced sale is triggered; an already fully invested book recovers liquidity when
natural exits/trims release it. All eight-name, sector, risk, opposing exposure,
quote, minimum-entry and protection checks remain. A reserved dollar or slot is
not a buy signal. India has no equivalent approved leveraged sleeve and remains
unchanged; live settings/credentials/activation remain unchanged.

Use the existing `leveraged-sleeve-risk` module, paper constructor/spend code and
Paper Portfolio header. Record the policy identity and exact reserve in existing
stage/run evidence. No new producer, table/column, schedule, package or API route.
Migration plan: narrow the existing service-only `execute_paper_fill` RPC after
its market-pool row lock to recompute full marked NAV and combined leveraged
value, reject ordinary US spend that consumes the unused sleeve reserve, and
count all positive distinct held names at the existing name-cap check. Top-ups
and atomic rotations reuse this function and retain the same guard. Dedicated
leveraged fills use their existing independent transaction and all entry gates.
Preserve signature, privileges and existing behavior for India/crypto except
that ordinary entry name counts include all actual held roles. Reject a missing
US transactional kernel instead of falling back to non-atomic writes. Verify
both authorization and row-lock behavior locally, apply through migration history,
and prove the exact function contract exists before shipping the caller/UI.
Compare paired full-book scenarios with the existing portfolio simulator and
paired replay accounting, including no opportunity, losing setup, winning setup,
full name slots, fees and preserved cash. These establish arithmetic and tradeoffs,
not historical return superiority. Missing historical marks/contracts still
prevent a defensible full-inception replay and automatic forced-sale promotion.

Mock endpoint/auth/cache/schema/future/session failures; minimum sizing at exact
boundary, real cash versus sleeve shortfall and all four route evidence paths;
historical journal dates and market isolation. Run focused/full tests, TypeScript,
secret scans, authenticated read-only UI checks. Push clean main, verify exact SHA
and production READY, then inspect natural scheduled evidence. No trading cron
or model inference is manually invoked to test delivery. Roll back new discovery
admission if it causes source degradation or crowds out approved priority work.
