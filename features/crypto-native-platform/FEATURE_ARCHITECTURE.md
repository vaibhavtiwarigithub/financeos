# Crypto-Native Research, Execution, and Learning

> Status: **Approved for Stages A–D by Vaibhav, 2026-09-16.** This does not
> authorize a live crypto order. Stage E remains preview/tap-approve only and
> Stage F requires a separate owner decision after its gates pass.
>
> Owner intent: Kairos should research, paper-trade, evaluate, and eventually
> execute crypto with the same rigor as equities — while treating crypto as a
> different market, not as a stock with larger stop percentages.

## 1. Decision

**Why:** The current Stage 3 crypto book collects useful paper evidence, but it
uses three selected assets, daily bars, a stock-shaped score, fixed 15%/25%
levels, and no benchmark or dedicated learner. That is an evidence collector,
not a credible crypto execution system.

**Who:** The Kairos owner, initially using the existing isolated crypto paper
pool and later an explicitly enabled Robinhood Crypto account.

**ROI:** A falsifiable, execution-aware crypto sleeve can prove whether there
is a net-of-cost edge before capital is at risk. The moat is disciplined refusal
and auditability, not an LLM inventing coin theses.

**Non-goal:** "Trade every coin", always be invested, or enable autonomous live
crypto because a paper signal looks attractive. No live stage is released merely
because this design is implemented.

## 2. Pressure-tested operating facts

- Robinhood supports crypto market, limit, stop, and stop-limit orders, but
  Kairos must capability-probe the account and pair before treating any order
  type as available. Robinhood says a sell stop converts to a market order and
  may execute with up to a 5% buffer; that is not a guaranteed exit price.
- Crypto trades 24/7 and Robinhood notes scheduled maintenance exceptions. A
  weekday stock cron and a daily close price cannot claim continuous protection.
- Displayed mid price is not executable. Robinhood distinguishes bid/ask from
  mid and warns that spread varies materially by coin and liquidity.
- Limit/stop-limit orders can fail to fill. Therefore a target and a stop are
  *policies plus reconciled order state*, not two numbers recorded on a position.

Sources: [Robinhood crypto order types](https://robinhood.com/us/en/support/articles/order-types/),
[Robinhood buying and selling crypto](https://robinhood.com/us/en/support/articles/360001298246/),
[Robinhood crypto routing](https://robinhood.com/us/en/support/articles/360022216832/).

## 3. Architecture decisions

### 3.1 Separate crypto research lane and candidate universe

The active universe is **not** every listed token and is never a static hardcoded
list. A daily `CryptoUniverseCollector` reads the broker's tradeable-pair
inventory and writes a point-in-time snapshot with account eligibility,
jurisdiction availability, quote availability, observed spread, and 30/90-day
history coverage. It admits a pair to research only when all are true:

1. broker says the pair is tradable for the connected account;
2. at least 90 completed UTC daily bars and the required intraday history exist;
3. executable quote is current and spread is below a configured, evidence-backed
   ceiling; and
4. the pair is neither halted, maintenance-blocked, nor on a manual deny list.

The collector cannot buy, score-promote, or mutate a watchlist. It only creates
the candidate population and records why a pair was refused.

### 3.2 A crypto-native deterministic score

`CryptoScore v1` is deterministic and versioned. It has no stock P/E,
earnings, analyst-target, insider, or US-equity-macro substitute. Inputs are:

| Dimension | Purpose | Initial role |
| --- | --- | --- |
| Trend / relative strength | Trend across 1d, 4h, and 1h bars; rank only against eligible crypto pairs | candidate selection |
| Volatility / regime | ATR, realized volatility, gap/jump frequency, BTC market regime | sizing and stop geometry |
| Liquidity / execution | bid-ask spread, quote age, traded-volume proxy, recent fill/slippage history | hard eligibility veto |
| Market structure | distance from moving averages, breakout/retest, drawdown state, volume confirmation | entry/exit evidence |
| Event / sentiment | provider-backed crypto news only, timestamped and availability-tracked | measure-only until predictive IC clears a gate |
| Network data | only if a licensed provider supplies point-in-time, symbol-consistent data | measure-only; no fabricated "fundamentals" |

No LLM can emit a score, tradeable flag, stop, target, or regime. An LLM may
summarize already-persisted deterministic evidence for the UI, clearly labelled
as commentary.

### 3.3 Dedicated crypto genome, not the equity genome

Create `crypto_strategy_versions`, `crypto_strategy_evaluations`, and
`crypto_shadow_configs` rather than widening equity genome tables. A crypto
genome may vary only bounded, interpretable parameters:

- timeframe family (daily/4h/1h), trend lookbacks, and breakout confirmation;
- ATR / realized-volatility stop multiple and invalidation rule;
- target policy (fixed reward multiple versus deterministic trailing policy);
- maximum spread, maximum quote age, minimum history, and concentration cap;
- risk-per-trade and total crypto-sleeve risk.

It may **not** mutate into leverage, martingale/recovery sizing, averaging down,
unbounded turnover, or a new order type. Candidate/champion/shadow transitions
reuse the existing one-champion state machine but have their own evidence tables
and crypto-only purged walk-forward evaluation.

### 3.4 Deterministic entries, stops, targets, and exits

At entry, `CryptoExitGeometry` receives a frozen executable quote, current
volatility regime, entry setup invalidation level, and expected costs. It emits:

- `stop`: the more conservative of structural invalidation and an ATR-volatility
  floor, but never wider than the configured maximum loss;
- `target`: a deterministic reward/risk or trailing-policy level *only if*
  expected net reward after worst-case spread/slippage exceeds the required
  threshold;
- `size`: risk budget divided by stop distance plus expected execution cost,
  bounded by a crypto sleeve cap, coin cap, and cash availability;
- `refusal`: if any input is stale, spread is excessive, stop distance is too
  wide/narrow, or net expected reward fails after costs.

There is no unconditional calendar exit. A position can exit only because the
protective stop is triggered, target/trail policy fires, the deterministic thesis
is invalidated, or a safety kill switch closes/requires owner intervention.

Every exit decision stores its geometry inputs and version, so actual net return
can be compared against expected return, expected loss, quote spread, and fill
slippage.

### 3.5 Paper execution before live execution

Paper must model bid/ask, fees, partial fill, rejection, cancellation, and
quote age. It cannot keep filling at candle close. `CryptoPaperExecutionAdapter`
will consume the same quote contract as future live execution, record a fill
model version, and create a simulated order lifecycle.

Paper targets/stops are evaluated from intraday high/low only after that bar is
complete; ambiguous bars resolve adversely. This preserves the Stage 3 safety
rule while permitting a higher-frequency shadow.

### 3.6 Live execution safety kernel

Live code is built behind `CRYPTO_LIVE_ENABLED=false` and a separate owner-only
settings switch. It starts at preview-only, then owner tap-approve, then may
become autonomous only after evidence gates. It must require all of:

1. broker onboarding, account eligibility, pair availability, crypto buying
   power, and a fresh quote verified immediately before preview and submit;
2. deterministic `CryptoExitGeometry` pass and a stored idempotency key;
3. a successful broker preview whose expected price/cost is within the policy
   tolerance; and
4. a fresh global and crypto-specific kill switch, risk budget, max exposure,
   daily loss, order-rate, and duplicate-order checks.

Because broker-native OCO/brackets are not assumed available, **a live entry is
rejected until the execution supervisor proves both sides of protection are in
force or explicitly records why it cannot establish them.** The supervisor
reconciles broker orders/positions every minute, detects partial fills and
rejections, cancels stale sibling orders, and raises a critical alert when a
live position lacks a verified protective state. It never silently replaces a
missing broker stop with an application-only promise.

### 3.7 Benchmarks and Crypto Markets workspace

Add `/dashboard/crypto` rather than hiding crypto in a stock page. It shows:

- universe funnel: broker-listed → eligible → researched → scored → paper/live;
- each score dimension, source timestamp, quote/spread, and deterministic
  reason for buy, refusal, hold, or exit;
- separate paper/live NAV, cash, positions, realized/unrealized P&L and every
  order lifecycle event;
- benchmark comparison against BTC buy-and-hold plus a frozen, equal-weight
  eligible-universe reference. Neither benchmark is presented as a universal
  crypto market proxy; both have point-in-time constituents and session labels;
- strategy table: version, paper/live state, weeks observed, trades, net return,
  max drawdown, win rate, profit factor, IC and uncertainty. No "winner" badge
  before a predeclared minimum sample and out-of-sample gate.

The existing `/dashboard/trading` Crypto Watch remains a compact summary linked
to this workspace.

## 4. Delivery stages and gates

| Stage | Deliverable | Cannot do | Promotion gate |
| --- | --- | --- | --- |
| A | Broker inventory + quote capability probe, data contracts, workspace shell | score, trade, write a live order | verified pair/onboarding/quote coverage |
| B | Crypto score v1, candidate funnel, feature ledger, IC pipeline | paper entry | completed labels and source-quality coverage |
| C | Crypto genome + execution/exit-geometry shadows | execute paper/live | purged OOS evidence and net-cost replay |
| D | Intraday paper lifecycle, benchmarks, strategy comparison | live order | minimum paper fills/exits, reconciliation and adverse-fill tests |
| E | Preview-only then owner tap-approve live adapter | autonomous live order | real broker preview/reconciliation drills and explicit owner choice |
| F | Autonomous live, if ever | change genome without gate | sustained shadow/paper/live readiness, independent review, owner switch |

## 5. Acceptance criteria

1. Every tradable candidate was broker-eligible at the recorded time; every
   excluded candidate has a recorded reason.
2. A crypto score is reproducible from immutable input timestamps and version.
3. No current-day/incomplete candle, stale quote, mid-price-only quote, or
   missing spread can enter paper or live geometry.
4. A mutated rule that bypasses liquidity, max-risk, stale-quote, or broker
   eligibility must fail a test.
5. Reported performance is net of modeled/actual fees, spread, and slippage;
   paper and live are never co-mingled.
6. A live position without confirmed protective execution state creates a
   critical alert and blocks further entries.
7. Live crypto remains disabled until Stage E’s explicit owner action. Stage F
   is a new decision, not a default.

## 6. Explicit deferrals

### Paper recovery implementation note — 2026-09-21

The existing Stage 3 paper basket remains BTC-USD/ETH-USD/SOL-USD; this repair
does not expand executable names or enable live trading. Public research always
prioritizes these three before bounded broker-discovered names, normalizes USD
symbols, and labels missing broker members non-tradeable. Native pipeline identity
uses `score_source`; constrained discovery `source` is `screener`. The previously
committed daily 00:45 UTC paper schedule is now applied. Non-cron entry invocation
requires the owner, not merely any signed-in viewer.

The fill RPC now has a crypto-only mandate branch (score 60, at most three names,
native claimed signal and reviewed basket required). Equity mandate lookup is
unchanged. The guarded migration refuses unexpected RPC source drift and was
first executed inside a rolled-back transaction. RPC mandate version is integer 1;
the descriptive policy name stays in the snapshot, not in the integer argument.

- no leverage, perpetuals, options, staking yield, lending, DeFi, transfers, or
  custody/wallet functionality;
- no on-chain metric until it is licensed, point-in-time, and coverage-audited;
- no claim that a high paper win rate or a single strategy is a proven edge;
- no copying equity benchmark, target, stop, or genome parameters into crypto.
