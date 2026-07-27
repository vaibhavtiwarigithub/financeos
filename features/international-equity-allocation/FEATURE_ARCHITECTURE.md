# International Equity Exposure Architecture

> Status: **P0 SHIPPED (read-only). P1-P4 remain unapproved.**
> Date: 2026-07-27
> P0 shipped: current US paper-book country-ETF visibility only. It has no
> schema, provider, registry-write, allocation, paper-trading, or live-trading
> effect. P1-P4 require separate approval.

## P0 Implementation (2026-07-27)

- `lib/allocation/international-exposure.ts` calculates a current US paper-book
  view from existing persisted paper marks only. It uses a deliberately narrow,
  static country-ETF map; other ETFs remain unavailable rather than inferred.
- `components/dashboard/InternationalExposurePanel.tsx` renders the read-only
  Portfolio panel with a disabled/no-action state, recognized-country exposure,
  unclassified-ETF disclosure, and cost-mark disclosure.
- The panel is hidden on the India view. It cannot read India holdings or mix
  USD and INR. No position, policy, instrument registry, provider ledger, or
  money-path writer was added.

## 1. Decision

Kairos should eventually support **non-US equity exposure inside the US/USD book**
through reviewed, US-listed international ETFs. It must not create an
`international` market, a third cash pool, or an automatic country-ETF trading
strategy.

This is strategic geographic diversification, not a short-horizon alpha claim.
The first product is a read-only allocation decision surface that answers:

1. How much of the US equity sleeve is already exposed outside the US?
2. Is the portfolio materially concentrated in US geography, sectors, or common
   global revenue sources?
3. Does the owner's approved target call for a broad non-US core, and is the
   actual exposure outside its allowed band?
4. Is a proposed fund a broad core, a complementary developed/emerging sleeve,
   or a concentrated country satellite that duplicates existing exposure?

The current allocation core remains off. This proposal does not change
`allocation_enabled`, score a symbol, add watchlist candidates, consume a new
provider quota, place a paper trade, or place a broker order.

## 2. Why This Is the Right Boundary

A US broker account can obtain international equity exposure through US-listed
funds without operating a foreign-market execution system. A broad vehicle such
as [VXUS](https://investor.vanguard.com/investment-products/etfs/profile/vxus)
tracks a developed-and-emerging-markets index excluding the United States.
That is materially different from a single-country vehicle such as
[INDA](https://www.ishares.com/us/products/239659/INDA), which the issuer
describes as a targeted India exposure and currently has a large financials
weight. Broad geographic diversification can reduce home-country concentration,
but it is not a promise of higher return or a signal to tactically rotate every
week. [Vanguard's research](https://corporate.vanguard.com/content/corporatesite/us/en/corp/articles/making-case-international-equity-allocations.html)
also frames the benefit as diversification and volatility reduction, not a
market-timing rule.

The existing India pipeline is a separate INR book. It has its own market hours,
research, paper pool, risk controls, and benchmark. A US-listed India ETF is a
USD instrument with India geographic exposure; it belongs in the US book if ever
approved. It must not be combined with, rebalance against, or treated as a
substitute for India-pipeline holdings.

## 3. Non-Negotiable Invariants

1. **Two market pools only.** A US-listed international ETF has
   `market=us`, `currency=USD`; the underlying geography is metadata. India
   remains `market=india`, `currency=INR`. No US/India NAV, P&L, cash, cap,
   performance, or exposure percentage is cross-summed.
2. **Strategic sleeve, not a generic candidate.** Broad and country ETFs do not
   enter the ordinary 2-20 day ResearchAgent queue or compete with single-name
   scores. They use a slow allocation/rebalance process only after approval.
3. **One core construction at a time.** The system may hold either one broad
   ex-US core, or a deliberate developed-plus-emerging split. It cannot call
   overlapping cores diversification.
4. **Country funds are satellites.** A single-country ETF never satisfies the
   international-core target. Its geographic, sector, issuer, and existing-book
   overlap must be shown before it can be proposed.
5. **No US-macro proxy.** Existing US MacroSentinel cannot decide whether an
   international ETF is attractive. Future domestic/global evidence is
   read-only until it demonstrates incremental, point-in-time value by fund
   archetype.
6. **No LLM decision authority.** An LLM may explain persisted allocation facts;
   it cannot choose a fund, set a target, determine overlap, or trigger an
   order.
7. **Default deny.** An unregistered ETF, stale fund facts, unavailable
   geographic look-through, or ambiguous classification produces `unavailable`
   and no proposal, never a neutral or buy recommendation.
8. **Existing brakes remain authoritative.** Any future paper/live action still
   passes app pause, market controls, kill switch, drawdown breaker, market
   session, account scope, mandate, caps, idempotency, and live approval gates.

## 4. Exposure Model

### 4.1 Portfolio hierarchy

```
US/USD book
  -> equity sleeve
       -> domestic US equity exposure
       -> international-core sleeve (optional, slow allocation)
            -> broad ex-US OR developed + emerging split
       -> country satellite sleeve (optional, smaller and independently capped)
India/INR book
  -> unchanged India equity/defensive/cash sleeves
```

`international_core` and `country_satellite` are US-book sleeve labels, not
markets. They extend the existing `strategy_sleeves` concept only after an
approved migration and must retain its per-market key.

### 4.2 Permitted construction patterns

| Pattern | Intended use | Initial status |
|---|---|---|
| One broad ex-US core, e.g. VXUS | Default diversified international exposure across developed and emerging markets | Candidate for P0 measurement only |
| Developed ex-US + emerging split, e.g. VEA + VWO | Owner deliberately wants a controlled developed/emerging mix | Candidate for P0 measurement only; mutually exclusive with broad core |
| Single-country, e.g. INDA | Explicit small satellite hypothesis or owner-directed concentration | Observe only; not a core and not an ordinary research candidate |
| Multiple India country ETFs, e.g. INDA + EPI + INDY | Apparent variety with heavy geographic overlap | Prohibited without look-through proof and a separate owner decision |

The product must not preselect tickers as an investment recommendation. The
issuer's current fund facts, expense ratio, liquidity, holdings, index method,
and broker fractional eligibility are data to verify at proposal time, not
permanent constants in source code.

### 4.3 Target and band semantics

The owner selects a target as a percentage of the **US equity sleeve**, not of
total personal net worth, because Kairos does not have a complete, reconciled
view of every external asset and liability. It shows both denominators clearly:

- `US book NAV`: useful for execution capacity only.
- `US equity sleeve`: the only denominator for this allocation policy.
- `Known Kairos portfolio`: informational only; never represented as total wealth.

No default percentage is set in code. The initial UI asks for a target and
rebalancing band only after P0 data has exposed the current geographic
concentration. A target of zero remains the shipped default.

Bands create **slow** actions:

- below lower band: a future proposal may buy the selected core;
- inside band: hold, regardless of recent relative performance;
- above upper band: a future proposal may stop new core buys or propose a slow
  rebalance, subject to taxes, costs, and approval;
- unavailable/stale input: hold and surface the gap.

No band breach is an immediate sell signal and no international allocation
rebalance can override a protective position exit.

## 5. What Determines Where Exposure Belongs

### 5.1 Core decision matrix

| Input | What it answers | Allowed initial effect |
|---|---|---|
| Current fund look-through | Country, region, sector, and issuer overlap across held ETFs | Display and duplicate-exposure warning |
| Current US-book holdings | Concentration in US/foreign revenue, sectors, and names when reliable tags exist | Display only; unknown exposure remains unknown |
| Owner target and band | Desired strategic non-US share of US equity sleeve | Display a deterministic below/inside/above-band state |
| Fund eligibility | Registration, exchange, currency, instrument archetype, liquidity, fee, and stale-fact checks | Refuse proposal when incomplete |
| Tax and account constraints | Whether a sale/rebalance could be uneconomic | Refuse or require explicit owner approval |
| Domestic/global exogenous evidence | Global risk context and country-specific stress | Context only in P0-P2; never a timing score |

### 5.2 Geographic look-through rules

1. Store fund composition snapshots with `as_of`, source URL, retrieval time,
   holdings/fund-facts fingerprint, and coverage percent. Never silently use
   today's holdings for a historical allocation decision.
2. Report `known`, `unknown`, and `overlap` portions separately. Do not
   renormalize known holdings to 100% when coverage is incomplete.
3. Use country/region weights first. Sector/issuer overlap is supplementary and
   must be constrained by source coverage.
4. For a country satellite, show overlap with the India/USD ETF sleeve and any
   directly held Indian ADR/US-listed exposure. It does not read India/INR
   position data into US sizing.
5. A fund-of-funds, derivative, or opaque product needs explicit classification;
   it is not inferred from its ticker or marketing name.

## 6. Data and Architecture Fit

### 6.1 Reuse, do not create a parallel truth layer

The build must extend these existing contracts:

| Existing component | Required use |
|---|---|
| `instrument_registry` | Reviewed archetype, market, currency, execution eligibility, and default-deny behavior |
| `strategy_sleeves` | Eventual US-book target/band configuration; no global singleton setting |
| Existing live/paper position and NAV projections | Current US-book exposure inputs, preserving account scope and currency |
| `evidence_records`, `provider_call_ledger`, `evidence_cache_v2` | Provenance for all externally sourced fund and risk facts |
| `symbol_daily_returns` | Later frozen, same-market measurement only; no current-price backfill for historical claims |
| `features/exogenous-risk-evidence` | Future domestic/global context source; remains observation/shadow-only until independently admitted |
| Existing allocation core | Eventual deterministic band calculation, still off until its current sizing/rebalancer work is completed |

New records, if P1 is approved, should be a versioned `fund_exposure_snapshot`
and an immutable `allocation_assessment`, each linked to the above evidence
fingerprints. They must not replicate prices, positions, evidence cache, or
broker account data.

### 6.2 Required instrument archetypes

| Archetype | Market/currency | Research path | Allocation role |
|---|---|---|---|
| `international_equity_core` | US/USD | Excluded from generic scoring | Optional strategic core |
| `international_equity_developed` | US/USD | Excluded from generic scoring | Optional complementary split only |
| `international_equity_emerging` | US/USD | Excluded from generic scoring | Optional complementary split only |
| `country_equity_satellite` | US/USD | Excluded from generic scoring | Optional capped satellite, never core |
| `india_equity` | India/INR | Existing India path | Unchanged; not a substitute or counterweight |

## 7. Phased Build and Timing

Calendar estimates are engineering ranges, not evidence promises. A phase does
not advance just because its dates have elapsed.

### P0 - Inventory and read-only decision surface (2-3 engineering days)

1. Add an owner-reviewed starter policy catalog with archetypes and no enabled
   instruments. Do not seed an allocation target.
2. Inventory existing US-book ETF/ADR exposure and static overlap warnings.
3. Build a Portfolio > Allocation read-only section: US book separately,
   selected construction status, known/unknown geographic coverage, duplicate
   warnings, target-band state, data freshness, and `no action` state.
4. Prove that no item enters ResearchAgent, ThemeScout, PaperTrader,
   PositionMonitor, capital rotation, or live trader.

Acceptance: with no policy selected the surface states that international
allocation is disabled; it neither fetches a new market-data feed nor changes
the research backlog or provider-call ledger.

### P1 - Authoritative look-through and policy records (3-5 engineering days)

1. Add source-backed fund exposure snapshots and the append-only allocation
   assessment record.
2. Enforce one core construction and prohibit undocumented overlap.
3. Add fund eligibility/staleness/cost/liquidity checks and account/tax warning
   states.
4. Apply RLS and service-only writer protections; verify the target production
   schema and client denial before claiming completion.

Acceptance: every displayed country allocation has an as-of source snapshot,
coverage percentage, and immutable evidence fingerprint. A stale or partial
snapshot yields `unavailable` and no proposed action.

### P2 - Paper allocation shadow (minimum 8-12 weeks of observations)

1. Recalculate target-band decisions on a slow cadence (weekly at most) without
   creating paper positions or consuming broker/provider execution quota.
2. Record proposed action, suppressed action, costs, coverage, and exact input
   fingerprints.
3. Compare three mutually exclusive policy families: no non-US sleeve, broad
   core, and developed/emerging split. Country satellites are evaluated as a
   separate hypothesis, not merged into the core result.
4. Measure turnover, costs, dividend/tax assumptions, drawdown, concentration,
   and exposure stability. No retrospective current-holdings reconstruction.

Acceptance: zero cross-currency records, zero generic ResearchAgent entries,
and reproducible weekly proposals. Operational evidence is healthy for at least
8-12 weeks; long-horizon performance claims remain unproven.

### P3 - Paper execution, only after P2 and allocation-core completion

1. Finish the already-deferred allocation sizing/rebalancer work with a US-only
   international sleeve and a band/deadband.
2. Require a separate paper-only feature approval and a tax/cost-safe proposal
   ledger. Rotation cannot use an international sleeve to bypass its own gates.
3. Restrict actions to the selected core construction and owner cap. Country
   satellites remain disabled unless their separate study passes.

Acceptance: an action is serialized per US pool, idempotent, gate-complete,
and cannot force-close a single-name position or override a stop/target.

### P4 - Live consideration (no fixed date)

Requires all of: explicit owner approval, paper evidence, longer-horizon
historical/PIT evaluation, broker and fractional-share eligibility, tax review,
and a separate live-order architecture review. It must start in manual approval
mode. No inference from the presence of a Webull or Robinhood connection is
permission to enable it.

## 8. Validation Standard

This architecture deliberately does **not** promise that international exposure
will outperform US equities. The validation question is whether a chosen policy
delivers the stated diversification objective after realistic implementation
costs, without creating unacceptable concentration or churn.

Before a performance-oriented promotion, require:

1. Point-in-time fund composition and return inputs, including delistings,
   distributions, fees, rebalances, and corporate actions as applicable.
2. Walk-forward comparisons against the policy's declared baseline, with no
   target tuning on the test window.
3. A long enough span to include distinct currency/rate/regime periods. An
   8-12 week shadow proves operations, not strategic allocation quality.
4. Costs, spreads, taxes, and account constraints applied before any claimed
   benefit.
5. Market-local reporting: US allocation results in USD and against its selected
   US-book benchmark; India results, if separately designed later, in INR and
   against NIFTY. Never create an aggregate alpha number.

Until then, global risk evidence and relative strength can explain context only;
they cannot time entry or exit from the international sleeve.

## 9. UI Contract

The eventual Portfolio > Allocation section is a dense operational surface, not
a recommendation feed. It shows:

- US-book current/target/band values and the explicit denominator;
- selected construction (`disabled`, `broad core`, or `developed + emerging`);
- country/region weights with known/unknown coverage;
- detected duplicate exposure and country-satellite caps;
- source as-of time, quality, and missing-data reason;
- current policy result: `disabled`, `hold`, `below band`, `above band`, or
  `unavailable`;
- a full audit trail of inputs and hypothetical actions.

It must visibly distinguish an educational allocation observation from an
approved paper proposal and from a broker order. No buy/sell button appears in
P0-P2.

## 10. Explicit Non-Goals

- No direct foreign exchange or foreign-broker trading.
- No third market or pseudo-currency pool.
- No use of India paper/live cash to fund a US-listed India ETF.
- No automatic country rotation, momentum chasing, or weekly macro timing.
- No addition of VXUS, VEA, VWO, INDA, EPI, INDY, or similar funds to the generic
  stock watchlist merely because they are available.
- No use of an LLM, TradingView, social/news sentiment, or a chart pattern to
  choose geographic allocation.
- No live allocation change, provider quota expansion, or API key requirement
  in P0-P2.

## 11. Owner Decisions Needed Before P1

1. Is the first objective broad diversification only, or is a tactical country
   satellite allowed at all? Recommendation: broad diversification only.
2. What is the desired non-US share of the US **equity sleeve** and allowed
   deadband? Recommendation: choose after P0 displays actual look-through;
   default remains zero until explicitly set.
3. Is the permitted construction one broad core, or a developed/emerging split?
   Recommendation: one broad core initially because it has the least overlap
   and operating complexity.
4. Are any US-book accounts tax-sensitive enough that a rebalance must always
   be manual? Recommendation: yes by default until tax-lot and account-policy
   facts are fully modeled.
5. Should any country satellite be evaluated later? Recommendation: defer it
   until the broad-core policy and look-through data are operating correctly.

## 12. Recommended Next Step

Approve **P0 only**. It is the smallest useful answer to “when, how, and where”:
show existing exposure, select no more than one construction, make overlap
visible, and keep all trading paths unchanged. P1-P4 remain gated by P0 evidence
and separate approvals.
