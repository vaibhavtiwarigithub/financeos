# Leveraged ETF Sleeve and Intraday Execution Architecture

**Status:** DRAFT - approval required before implementation
**Date:** 2026-07-26
**Scope:** US paper book first. India, live trading, inverse ETFs, options, and extended-hours trading are explicitly out of scope.

## 1. Decision

Kairos should not enable leveraged ETFs through the generic ETF path. A long leveraged
ETF is a distinct instrument class with a daily-reset return objective, path-dependent
multi-session results, and materially higher gap and execution risk. The correct first
product is an isolated, paper-only US sleeve that is disabled by default.

The proposed initial envelope is:

| Limit | Initial policy |
|---|---:|
| One leveraged ETF | 3% of US paper NAV |
| Entire leveraged ETF sleeve | 5% of US paper NAV |
| Number of leveraged ETF positions | 1 |
| Market | US / USD only |
| Direction | Long leveraged only |
| Default state | Disabled |

The 3% and 5% limits are ceilings, not target allocations. A 5% sleeve can lose its
entire paid value, or about 5% of the US portfolio at the entry-time NAV, if its
products go to zero; a 3x product also creates roughly 15% initial index-equivalent
exposure before path effects. Stops do not eliminate gap risk. These are risk-envelope
defaults, not evidence-based alpha parameters, and must not be raised automatically.

The broader goal is to borrow institutional *discipline*, not to imitate Renaissance
or Medallion. Kairos does not have their proprietary data, dense diversified signal
library, low-latency execution, capacity research, or decades of independent outcomes.
The relevant, achievable standard is reproducible point-in-time research, realistic
costs, strict market-local risk limits, out-of-sample promotion, and operational
monitoring. No return target or claim of Medallion-like capability is valid.

### Quant capability target

| Capability | Kairos direction | What not to pretend |
|---|---|---|
| Data provenance | Freeze evidence, policy, code, and quote fingerprints per decision | That a retail/free-data feed is an institutional consolidated low-latency feed |
| Research validation | Point-in-time replay, walk-forward, purging, costs, and regime slices | That a backtest proves a live edge |
| Portfolio construction | Market-local constraints, concentration/correlation controls, and explicit sleeves | That a small number of paper outcomes calibrates a universal optimizer |
| Execution | Fresh quote, spread, drift, idempotency, reconciliation, and broker protections | That cron polling can compete with a market maker or HFT firm |
| Learning | Separate populations and promotion defaults-to-no-change | That an LLM or a short sample can discover stable alpha |

These are the useful quantitative similarities to pursue. Additional indicators,
more agents, or frequent retraining are not substitutes for these controls and are
not part of this feature.

## 2. Existing State and Gaps

### Existing controls that must remain in force

- `lib/trading/symbol-policy.ts` blocks leveraged and inverse ETFs from generic
  research, paper, and live paths.
- `lib/asset-classification.ts` identifies a static set of known US ETFs, including
  several leveraged products. This is insufficient as an authority for a new money
  path because it does not model leverage factor, direction, issuer, or status.
- The generic US ETF allocation cap in `lib/trading/execute-order.ts` is a global ETF
  cap. It is not a leveraged-sleeve cap and cannot authorize a leveraged trade.
- Paper entry attempts currently occur at two deterministic in-session windows:
  US at 15:15 UTC and 19:15 UTC, and India at 09:40 IST and 13:15 IST. The US
  wakes are 11:15/15:15 EDT and 10:15/14:15 EST, respectively. They are not
  random or continuously polling entries, but static UTC cron cannot preserve an
  exact ET minute across daylight saving.
- The live auto worker and live exit monitor exist behind false-by-default deployment
  and database gates. They must remain disabled for this feature's paper phases.

### Gaps that block an enablement

1. Static ticker lists cannot safely classify all future leveraged, inverse, single-
   stock, or renamed funds.
2. The current technical score is a general equity score. It does not measure daily
   reset/path risk, underlying trend persistence, intraday liquidity, or execution
   spread for a leveraged product.
3. Paper PositionMonitor is not a reliable intraday protective system. A periodic
   quote check cannot protect an outage or overnight gap.
4. Existing paper results are not an isolated leveraged-ETF experiment and cannot
   justify sizing or live activation.

## 3. Instrument Classification and Allowlist

Create a server-owned `tradable_instruments` policy record rather than inferring from
a ticker. The initial record fields are:

```ts
type InstrumentPolicy = {
  symbol: string;
  market: "us" | "india";
  currency: "USD" | "INR";
  assetType: "equity" | "etf";
  leverageClass: "none" | "long_2x" | "long_3x" | "inverse" | "leveraged_inverse" | "unknown";
  underlyingSymbol: string | null;
  sleeve: "core" | "leveraged_us" | "blocked";
  enabledForPaper: boolean;
  enabledForLive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  reviewedAt: string;
};
```

Rules:

- Only explicit `long_2x` or `long_3x`, `sleeve='leveraged_us'`, and
  `enabledForPaper=true` may reach the isolated paper candidate flow.
- `inverse`, `leveraged_inverse`, `unknown`, single-stock leveraged products, crypto
  leveraged products, and every unlisted ticker remain blocked. The existing paper-
  only hedge exception remains separate and may not use this sleeve.
- The first allowlist must contain only broad, liquid, long index/sector products.
  It must not include single-stock or crypto leveraged ETFs. Each addition is an
  owner-reviewed policy change with an audit record, not a watchlist side effect.
- A policy lookup/read error is a money-path denial. It may not fall back to the
  old static ticker set.

## 4. Leveraged-ETF Decision Model

No LLM may decide eligibility, instrument class, size, stop, target, or exit. LLM
output can explain a completed deterministic decision only.

The leveraged model is a second deterministic gate after the normal new-long gates;
it can only reject or reduce an otherwise valid candidate.

### Required measurements

| Measurement | Purpose | Initial use |
|---|---|---|
| Underlying trend and persistence | Daily-reset leverage benefits more from persistent than choppy moves | Require a pre-declared, paper-validated underlying trend regime; no ad-hoc threshold |
| Realized volatility and ATR-normalized range | Detect path-risk / volatility drag conditions | Reject or reduce exposure above a market-local calibrated ceiling |
| Gap and overnight risk | Daily stops do not control discontinuous loss | Require a maximum expected loss and separate overnight policy |
| ETF quote age, bid/ask spread, dollar volume | Avoid paying large implementation shortfall | Fail closed on stale/unavailable quotes or excessive spread; thresholds calibrated from observed data |
| Underlying/ETF tracking sanity | Catch stale, dislocated, halted, or bad price data | Reject on abnormal divergence, stale underlying, or a trading halt |
| Portfolio beta/correlation | Prevent duplicate exposure (for example, QQQ plus TQQQ) | Enforce against the US book using the existing correlation framework; never cross-sum India |
| Event risk | Avoid automatic entry immediately before known binary events | Start with an exclusion policy for underlying index/sector events only where reliable data exists |

MACD, RSI, EMA, ATR, volume confirmation, and relative strength may be evaluated as
features in the isolated experiment. They are not sufficient by themselves, and none
should receive a permanent weight without point-in-time, costed, market-local evidence.
Fibonacci levels, Elliott wave, and similar discretionary chart patterns are not part
of this money path because they add degrees of freedom without a validated decision
contract.

### Sizing and exits

```text
leveraged_notional = min(
  normal_new_long_notional,
  3% of current US paper NAV,
  remaining 5% US leveraged sleeve capacity,
  liquidity/spread-constrained notional,
  volatility-scaled risk budget,
  all existing name/sector/gross/correlation/cash constraints
)
```

- Recalculate current NAV and all marks in USD at the same decision timestamp.
- Never use cost basis, stale cache values, or cash alone for sleeve capacity.
- A generic 7% stop / 20% target must not be copied blindly. The experiment records
  candidate volatility-normalized exits, but the active paper policy starts with a
  conservative deterministic stop/time-risk plan defined before entry and immutable
  on the trade record.
- No capital rotation into or out of this sleeve in the first phase. It would mix
  the new experiment with the established alpha book and amplify churn.
- The LearnerAgent cannot mutate the core champion or learn core signal weights from
  these outcomes. Leveraged outcomes have their own evaluation population.

## 5. Execution Sessions

Regular-session hours are 09:30-16:00 ET for US equities and 09:15-15:30 IST for
NSE equities. Kairos must remain regular-session-only. Extended-hours orders, random
polling, and "trade whenever a score changes" are out of scope.

The opening and closing periods have higher uncertainty, volatility, and often worse
spreads. A study of intraday trading activity finds U-shaped volume and price
variability, and liquidity research also documents wider spreads at the edges of the
day. Therefore, the product uses fixed decision windows, not a claim that any single
minute is universally optimal.

| Flow | US equities / ordinary ETFs | India equities | Leveraged-US ETF sleeve |
|---|---|---|---|
| Research | Existing morning and afternoon cycles | Existing morning and midday cycles | Reuse only a fresh same-session deterministic snapshot |
| New entry | Keep the existing two in-session wakes; normalize any future exact local-time policy in the route, not only in UTC cron | Keep existing 09:40 and 13:15 IST windows | One dedicated paper window, initially 11:00 ET, after the opening auction settles and before late-day rebalance pressure; never at the open or within 60 min of close |
| Routine exit review | Existing PositionMonitor policy | Existing PositionMonitor policy | Same end-of-session plan plus a separately qualified risk monitor |
| Emergency exit | Not a reason to add random entry polling | Not a reason to add random entry polling | Risk-reducing only: immediately actionable when reliable quote/broker state says the immutable stop/disaster rule fired |

The exact 11:00 ET leveraged entry time is a conservative starting experiment, not a
universal alpha claim. It must be compared with the existing fixed windows using
timestamped, costed paper evidence before it becomes a permanent policy. A cron may
wake the endpoint more broadly, but `America/New_York` time-window code must be the
single execution authority; DST can never silently move a policy window.

### Intraday exits: correct order of implementation

1. **Do not add an intraday exit cron using stale/free daily prices.** It could sell
   on a bad mark and create a false sense of protection.
2. Build a quote-quality contract: executable quote timestamp, bid, ask, spread,
   source health, halt/session status, and broker-held quantity.
3. In paper, record every would-exit at a fixed 15-minute cadence, but do not alter
   the established book until mark quality and false-trigger statistics are known.
4. For any future live entry, a broker-resident disaster floor/protective order plus
   reconciliation is required. The app monitor is a second line, not the primary
   protection against an outage or gap.
5. A risk-reducing verified SELL may run outside entry windows during the regular
   session. It remains subject to held-quantity/reconciliation guards, never a
   BUY budget, and never opens a short position.

## 6. Evidence and Promotion

The sleeve has a separate immutable experiment lineage. Each decision stores the
instrument-policy version, underlying and ETF quotes, features, rule version, entry
window, model outcome, transaction-cost assumptions, and market-local session date.

Required evidence before any expansion:

- point-in-time replay with correct fund availability and no survivorship additions;
- walk-forward evaluation and purged/time-separated validation;
- costs and conservative bid/ask/slippage sensitivity, not close-to-close returns;
- distinct regime slices (trending, high-volatility, mean-reverting) and a minimum
  number of independent setups, not daily observations counted as independent;
- comparison with the same underlying unlevered ETF and a cash/no-trade baseline;
- maximum drawdown, gap, false-exit, quote-quality, and reconciliation reporting;
- an owner-approved paper evidence threshold. Failure means no change, not a lower
  threshold.

No result from this experiment may promote a core strategy version, relax a generic
ETF cap, expand the live auto lease, or change India logic.

## 7. Phased Delivery

### L0 - policy and observability

- Add the classified instrument registry, owner-visible sleeve status, and a strict
  default-deny rule.
- Add a pure, tested market-local execution-window policy. It changes no existing
  schedule or order behavior in L0; later phases use it to enforce an approved ET
  window irrespective of UTC/DST.
- Keep all leveraged instruments blocked from generic research and execution.
- Add no cron, no provider, no live broker call, and no scoring influence.

### L1 - measure-only research

- Produce deterministic candidate feature records only for explicitly allowlisted
  instruments, paced separately from the core research quota.
- Capture quote quality, regime, normalized volatility, and would-enter/would-reject
  decisions. No paper fills.

### L2 - isolated paper sleeve

- Enable one US paper-only position under the 3%/5% envelope.
- Use the dedicated 11:00 ET entry window, immutable entry plan, and separate
  outcomes/analytics.
- Enable 15-minute *would-exit* observations only after quote contract tests pass.

### L3 - paper risk monitor

- If L2 shows reliable marks, activate deterministic risk-reducing paper exits at
  the approved cadence. Continue end-of-session monitoring as the fallback.
- Demonstrate no duplicate exits, no stale-mark exits, and correct market-local
  session behavior in failure injection.

### L4 - live design review only

- This is not authorization to trade live. It requires broker-native protective
  support, reconciliation, a live-specific allowlist, live account mandate, small
  owner-approved lease, and a separately approved architecture.

## 8. Acceptance Criteria

- An unclassified, inverse, leveraged-inverse, single-stock, crypto, India, or
  expired allowlist instrument is denied before any score, claim, fill, or order.
- The sleeve cannot exceed 3% for one name or 5% in aggregate using current US NAV.
- India INR holdings and capacity never participate in US sleeve calculations.
- A missing policy, quote, mark, NAV, spread, or correlation read rejects a new
  leveraged entry; it never falls back to the generic ETF path.
- Leveraged results are excluded from core LearnerAgent promotion/weight mutation.
- A repeated worker, stale quote, quote divergence, halt, partial exit, broker
  uncertainty, or kill switch cannot create a duplicate order or oversell.
- New entries occur only in their approved regular-session window. Verified
  risk-reducing exits may occur during regular session outside that window.
- No production flag, mandate, account, generic ETF cap, or live order capability
  changes in L0-L3.

## 9. Sources

- FINRA, [The Lowdown on Leveraged and Inverse Exchange-Traded Products](https://www.finra.org/investors/insights/lowdown-leveraged-and-inverse-exchange-traded-products): daily reset and the greater divergence caused by leverage and volatility.
- FINRA, [Non-Traditional ETFs FAQ](https://www.finra.org/rules-guidance/key-topics/etf/non-traditional-etf-faq): suitability must consider volatility, leverage, and holding period.
- Wei (1992), [Intraday Variations in Trading Activity, Price Variability, and the Bid-Ask Spread](https://doi.org/10.1111/j.1475-6803.1992.tb00804.x): empirical U-shaped intraday activity and variability.
- NYSE, [Trading Information](https://www.nyse.com/trade/trading-information?os=io_): US core session hours.
- NSE, [Market Timings and Holidays](https://www.nseindia.com/resources/exchange-communication-holidays): NSE regular equity session hours.

## 10. Explicit Non-Goals

- No claim of Renaissance/Medallion equivalence.
- No HFT, market making, order-book prediction, extended-hours trading, options,
  inverse ETF trading, or cross-market/currency netting.
- No new LLM authority, external GitHub skill runtime, or provider-quota increase.
- No live leveraged trade, even manually, under this architecture without the L4
  approval and a distinct live safety review.
