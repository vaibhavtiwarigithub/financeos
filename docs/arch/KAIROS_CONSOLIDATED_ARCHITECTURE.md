# Kairos / FinanceOS — Consolidated Architecture

> **Audience:** a new engineer, reviewer, or collaborator who needs to understand
> the complete application from one document.
>
> **Reviewed:** 2026-09-21
>
> **Status rule:** “Active” means the code and production contract are present.
> “Paper-only” means it can affect simulated books but never a broker. “Shadow”
> means evidence collection only. “Blocked” means a named prerequisite is missing.
> Historical feature documents are design records; this document describes how the
> system is connected today.

## How a finance professional should read this

Kairos uses familiar investment concepts, but records them more strictly than a
typical brokerage screen. A **symbol** is an instrument ticker. A **signal** is a
dated research decision. An **entry** is a buy execution. A **position** is open
inventory. A **lot** is one accounting slice of an entry or partial exit. A
**benchmark** is the market alternative for the same capital. A **shadow** is a
research experiment that cannot affect an order. A **session** is a completed US,
NSE or UTC crypto period, not merely the time a request ran.

The most important distinction is between a forecast and an allocation. A score of
78 means current evidence ranks a candidate highly; it does not mean a 78% return
or an all-in instruction. The portfolio constructor still checks cash,
concentration, liquidity, stop distance, correlation, controls and freshness.

## 1. Product purpose

Kairos is a personal AI-assisted quantitative investing operating system. It is
not a chat bot that invents trades and it is not a single-factor stock scanner.
It runs a controlled loop:

```text
market/provider evidence
        ↓
market-local research and deterministic scoring
        ↓
session-validated signals and decision evidence
        ↓
paper portfolio construction and simulated fills
        ↓
position monitoring, exits and reconciliation
        ↓
closed-trade labels, diagnostics and learning evidence
        ↓
validated shadows/challengers (never silent promotion)
```

The system supports separate US, India and crypto books. Paper comes before live
execution. Any live order must pass broker, data, risk, protection, idempotency
and owner-authorisation gates. LLMs can summarize persisted evidence, but they do
not have authority to invent a score, target, stop, position size or live order.

## 2. System boundaries and technology

The web application is Next.js App Router with TypeScript and React. Supabase
provides Postgres, Auth, Row Level Security, Vault, Realtime and pg_cron. Server
routes use Supabase server/service clients; browser components never receive a
service-role key. Owner-only APIs use the confirmed owner gate.

Production schedules run in Supabase pg_cron and call deployed API routes through
the Vault-backed `kairos_call_agent` bridge. Local Windows schedules are useful
for development but are not the production source of truth.

Main runtime areas:

- `app/dashboard/` and `components/dashboard/`: Investing workspace.
- `app/property/`: owner-recorded property/equity workspace.
- `app/capital-plan/`: capital profile and allocation workspace.
- `lib/data/`: provider adapters, caching and freshness contracts.
- `lib/scoring/`: deterministic equity and crypto scoring.
- `lib/trading/`: exits, ladders, geometry and order policies.
- `lib/brokers/` and `lib/robinhood-mcp.ts`: broker capability and execution adapters.
- `supabase/migrations/`: schema, RPCs, constraints and cron jobs.
- `features/`: feature-level architecture and decision records.
- `docs/arch/`: stable operational architecture chapters.

## 3. Workspaces and user interface

### Investing workspace

`/dashboard` is the owner’s operating console. Major routes are:

| Route | Purpose |
|---|---|
| `/dashboard` | Portfolio summary, NAV/cash, macro banner, health and agent status |
| `/dashboard/research` | Symbol scores, dimensions, thesis and dated evidence |
| `/dashboard/research/[symbol]` | Price/score history and symbol-level research detail |
| `/dashboard/learning` | Champion/challengers, validation and Performance Truth |
| `/dashboard/agents` | Agent cards, topology and per-agent diagrams |
| `/dashboard/upgrade-path` | Shadow inventory, evidence, blockers and attribution status |
| `/dashboard/markets` | Macro, breadth, sectors and benchmark market data |
| `/dashboard/smart-money` | Options/insider/sentiment evidence and trade queue |
| `/dashboard/india` | NSE research, INR paper book and Kite surfaces |
| `/dashboard/live-portfolio` | Broker positions, snapshots and live-vs-benchmark charts |
| `/dashboard/journal` | Signal → fill → exit → outcome decision journal |
| `/dashboard/mentor` | Evidence-based coaching notes |
| `/dashboard/backtest` | Historical validation/replay outputs |
| `/dashboard/scanner` | Bounded US/India candidate screening |
| `/dashboard/settings` | Broker connections, model routing, controls, keys and maintenance |

The System Reference surface is owner-only and reads a fixed allowlist. It is not
a repository browser. The Agent diagrams are rendered from
`public/agent-diagrams/system-map.json`, which is the topology source of truth.

### Property and Capital workspaces

Property stores owner-entered properties, financing, carrying costs, evidence
imports, market observations and shadow forecasts. It is not an automated AVM.
Capital stores allocation profiles, capital decision runs and capital-rotation
shadows. Neither workspace can silently place an investing order.

## 4. Markets, books and instruments

### US book

USD paper portfolio, US equity/ETF universe and broker-compatible symbols. The
ResearchAgent uses applicable fundamentals, technicals, sentiment, macro and
insider evidence. US paper fills support fractional shares. Robinhood is the
primary intended execution broker; Webull is a read-only research/broker surface
until its trading contract is explicitly enabled.

### India book

INR paper portfolio for NSE-compatible equity/ETF symbols. India uses market-local
calendar/session handling, local provider evidence and Zerodha/Kite compatibility.
India remains whole-share in the paper path unless an instrument contract says
otherwise. US macro is never copied into India as if it were local evidence.

### Crypto book

Crypto has an isolated USD paper pool. The approved initial paper basket is
BTC-USD, ETH-USD and SOL-USD; broker-discovered pairs are recorded separately.
Crypto uses public Coinbase/Kraken candles and quotes for research, Coin metadata
where available, and Robinhood MCP only for broker capability/execution truth.
Crypto does not reuse stock P/E, earnings, insider or equity-macro formulas.

Live crypto is disabled. The live path requires account/pair eligibility, fresh
executable quotes, preview acceptance, protective-order proof and reconciliation.

## 5. Data architecture

Every input has a source, observed timestamp, market/session, provenance and
quality state. Provider data is cached and quota-accounted. `price_cache` stores
OHLCV bars with provider/basis/provenance metadata. Evidence caches prevent the
research hot path from repeatedly spending provider quota.

Core data families:

- `agent_signals`: session-validated research decisions and score dimensions.
- `signal_score_history` / decision observations: dated score history and feature
  snapshots used for divergence and learning diagnostics.
- `paper_portfolio`, `paper_positions`, `paper_trades`: isolated paper books,
  positions, lots, partial exits and realized outcomes.
- `paper_order_events` / decision journal: immutable event and rationale trail.
- `live_account_snapshots`, `live_performance`, broker order tables: broker truth,
  never inferred from a paper ledger.
- benchmark observations and scorecards: market-local benchmark curves and
  expected-session freshness state.
- learning, shadow, validation and attribution tables: append-only evidence for
  proposed changes.
- System Health tables: failures, warnings, owner actions and auto-expiry state.

Data contracts fail closed. Missing or stale evidence becomes an explicit refusal,
not a fabricated zero. Database RPCs serialize cash/position changes and enforce
the money-path rules transactionally.

## 6. Agents and scheduled pipeline

### ResearchAgent

Runs market-local research after the relevant session boundary. It gathers a
bounded universe, fetches applicable evidence, computes deterministic dimensions,
writes signal observations and creates pending signals. It never directly buys.

### DeepSeek/alternate model lane

The LLM router can run alternative research prose/model assignments. Model output
is tagged and compared for paper outcomes; model prose cannot bypass deterministic
score or risk contracts.

### PaperTrader

Claims pending signals and performs: market-control check, kill-switch check,
session/fresh-price check, score threshold, cash, name/sector limits, duplicate
and anti-pyramiding checks, broker-compatible symbol check, and transactional fill.
The crypto paper trader is a separate route and RPC mandate branch.

### PositionMonitor

Runs after the market’s completed bar. It refreshes current marks, high/low
touch evidence, highest-price ratchets and exit decisions. A settled bar high may
trigger a target even when the close recovers. If stop and target conflict, the
policy remains conservative and stop precedence is preserved.

### LearnerAgent

Reads mature, non-tainted closed outcomes and produces summaries/challengers.
It does not mutate weights simply because a small in-sample result looks good.
Promotion requires declared samples, purged/out-of-sample validation, provenance,
and owner-approved state transitions.

### MacroSentinel and event agents

MacroSentinel creates an advisory market regime from provider-backed indicators.
It does not silently halt or throttle trading. Earnings, event maturation,
news/sentiment, insider, catalyst and risk-tier agents write evidence or shadows
with explicit availability and timestamps.

### Supporting agents

Theme/Edge discovery, evidence shadow, evidence cohort, price prewarm, benchmark
collectors, holding-risk, broker keepwarm, validation sweep and system-health
workers are separate scheduled jobs. Each route has a bounded runtime and reports
its own persistence/failure state.

## 7. Scoring model

The equity composite combines applicable dimensions: technical, fundamental,
sentiment, macro and insider. Instrument-aware applicability prevents a stock-only
fundamental formula from masquerading as ETF evidence. A shared weighted scorer
validates scores, weights and availability masks; unavailable dimensions do not
silently become zero-positive evidence.

Technical inputs include RSI, EMA relationships, trend, volume confirmation and
breakdown veto. EMA-200, MACD, relative strength and ADX may be measured shadows
until their market-local IC and forward-shadow gates clear. Fundamental inputs are
provider-backed and event-aware where possible. Sentiment and insider inputs carry
their own coverage flags.

The score threshold creates an eligibility candidate, not a guaranteed return.
Dimension rank IC, t-stat and code-version IC are monitored by market, cohort,
horizon, label maturity, qualifying sessions and overlap-adjusted effective sample
size. Current evidence is insufficient for automatic score-weight promotion.

Crypto score v1 is separate and deterministic: trend/relative strength, structure,
volatility/regime and liquidity/execution. Event/news/network features are
measure-only until they have timestamped, point-in-time coverage and predictive
evidence.

An **IC** is the rank correlation between a score and later return over a declared
horizon. A positive IC means higher-ranked names tended to return more in that
cohort; it is not a guarantee. The t-stat measures uncertainty. Kairos also tracks
qualifying sessions, label maturity and overlap-adjusted effective sample size so
overlapping daily observations are not mistaken for independent bets.

## 8. Portfolio construction and sizing

The constructor applies finite cash, gross exposure, name, sector, correlation,
volatility and risk-budget constraints. The live route uses broker equity snapshots
and its own protective gates; it must not silently use paper NAV. A cash balance is
capacity, not an instruction to buy. Extra cash is deployed only after fresh
research, current rank, risk and correlation checks.

The offline sizing replay compares equal planned allocation with equal stop-risk
allocation on the same frozen realized opportunities. It models costs, caps,
fractional US quantities, whole India quantities, partial exits and sampled
drawdown. It cannot claim the globally optimal size or assess missed opportunities.

The historical replay remains evidence-limited: India has 20 distinct symbol roots
without canonical price history, and partial-lot/stop provenance still needs
reconciliation. The separate top-up experiment is not a production feature.

For a stop-risk diagnostic, the planned amount is:

```text
risk fraction = (entry price - stop price) / entry price
planned notional = NAV × risk budget / risk fraction
```

Cash, name/sector/gross caps, correlation, share increments and transaction costs
then bound that amount. Cash is capacity, not a buy signal; unused cash can mean
that no candidate passed the current evidence and risk gates.

## 9. Exit geometry

Stops and targets are recorded with entry provenance, geometry version and observed
inputs where available. The ladder supports full target, partial target plus
runner protection, trailing protection, structural invalidation and score/direction
exit. The no-clock exit policy is intended to let valid winners run, but its
historical replay and intrabar semantics remain monitored carefully.

Crypto geometry is native: structural invalidation and ATR/realized-volatility
floor, expected costs, liquidity and maximum-loss bound. No unconditional calendar
exit is assumed. Paper crypto exits use completed OHLC bars and adverse resolution
for ambiguous barriers.

### Worked stock trade

For a $10,000 book, a $100 entry, $95 stop and $115 target, an 8% allocation arm
plans $800 before caps and costs. A 0.5% stop-risk arm sees 5% per-share risk and
plans $1,000 before caps. If the bar high reaches $115 but closes at $112, target
evidence can trigger the configured partial sale while the close remains the
conservative mark. If the same bar’s low touches $95, stop precedence resolves the
ambiguity adversely. The outcome is stored at lot level.

## 10. Benchmarks and charts

US and India benchmark collectors are market-local. Each run records expected
session, observed session, provider, benchmark and retry state. A run is `done`
only when every enabled benchmark reaches that market’s expected completed session;
otherwise it is partial/error. Freshness alerts resolve only after all configured
benchmarks advance.

Charts consume canonical persisted observations. They must not mix sessions or use
portfolio data from one market with another market’s benchmark. Benchmark-relative
performance is descriptive until a matched, frozen attribution experiment proves
an upgrade-path effect.

Crypto displays BTC buy-and-hold and a frozen equal-weight eligible reference as
separate benchmarks; neither is presented as a universal market proxy.

## 11. Learning, strategies and Upgrade Path

Upgrade Path is an evidence registry, not a list of promises. A path can be:

- **Operational:** proves a collector, guard or persistence contract.
- **Shadow:** records an alternative signal/strategy without changing behavior.
- **Paper cohort:** runs a controlled paper comparison.
- **Matched replay:** compares baseline and variant on the same population/window.

Measured attribution requires common market/window/population, frozen code/config
hashes, net cost basis, independent sessions, benchmark, drawdown, turnover,
confidence interval and exact variant-minus-baseline arithmetic. Aggregate portfolio
P&L cannot be relabelled as proof of one feature. The attribution ledger is empty
when no path has a valid producer; that is safer than manufacturing rows.

Capital rotation, external strategies, sector relative strength, catalyst/risk
tiers, model comparisons, time/ATR/volatility exit alternatives and leveraged ETF
strategies are shadows or proposals until their gates pass. TQQQ/SQQQ/SOXL/SOXS
require dedicated volatility/leverage-aware policies and must not inherit ordinary
equity targets or stops.

### Strategy lifecycle in investment terms

1. Declare universe, signal, holding/exit policy, costs, sizing and benchmark.
2. Run a shadow without changing the incumbent.
3. Wait for labels to mature and evaluate purged/out-of-sample folds.
4. Compare baseline and variant on the same opportunities and sessions.
5. Promote only through an owner-approved state transition.

“Ready” means the evidence contract is complete, not that the strategy wins every
week.

## 12. Broker and live safety

Robinhood MCP is capability-probed for accounts, pairs, quotes, previews, orders,
positions and reconciliation. Webull is not assumed to provide crypto execution.
Zerodha/Kite is the India execution contract. Broker support is checked for the
exact symbol before a live order.

Live order flow must verify: owner/live switch, active account, broker connection,
fresh account snapshot, pair eligibility, fresh executable quote, score/geometry,
cash/buying power, kill switches, daily loss/drawdown/rate limits, idempotency and
protective-order state. A live position without verified protection raises a
critical issue and blocks further buys. Viewer accounts can read only the routes
explicitly granted to them and cannot mutate owner settings.

## 13. System Health

Health separates critical failures from informational refusals and owner actions.
Examples of critical states are provider quota breaches, stale required market
data, failed persistence, broker-token failure, benchmark non-advancement and an
unprotected live position. A candidate refused for insufficient history is not by
itself a system outage; it is recorded as evidence.

Investigate in this order: expected session → provider/provenance → database row →
route response → cron run → UI. A green build or rendered card is not proof that a
money-path action succeeded.

## 14. Production schedules (conceptual)

Schedules are market-local and can have seasonal duplicate invocations that exit
before work. The important ordering is:

```text
provider/evidence prewarm
  → research and discovery
  → paper-entry attempt
  → post-close price prewarm
  → PositionMonitor
  → label maturation / diagnostics
  → weekly validation and shadow review
```

Crypto runs daily because the market is 24/7, while stock research and paper
execution follow US/India sessions. Every job is bounded, idempotent and expected
to write an `agent_runs` heartbeat or an explicit refusal/error.

## 15. Documentation and change governance

Use this document for the complete connected view. Use:

- `docs/arch/` for stable operational chapters;
- `features/*/FEATURE_ARCHITECTURE.md` for feature contracts and non-goals;
- `features/*/IMPLEMENTATION_RESULT.md` for shipped deviations;
- `PROJECT_DECISIONS.md` for owner approvals and reversals;
- `WORK_LOG.md` for delivery evidence and open work;
- `public/agent-diagrams/system-map.json` for topology.

Any change to a provider, agent, score dimension, applicability rule, schema/RPC,
cron, benchmark, money-path gate, learning/promotion rule or broker contract must
update this document and its detailed feature/chapter owner in the same change.

The safest interpretation of any missing evidence is “not proven yet.” Kairos is
designed to keep researching and measuring without silently turning a shadow into
capital.

## 16. Finance glossary

| Term | Kairos meaning |
|---|---|
| NAV | Cash plus marked position value for one isolated book |
| Gross exposure | Total long notional divided by NAV |
| Stop distance | Entry-to-stop percentage used for risk sizing |
| Slippage | Difference between expected and simulated/actual fill |
| IC | Rank correlation between score/rank and forward return |
| t-stat | Uncertainty statistic for an estimated effect |
| Purged fold | Validation split with a gap preventing label leakage |
| Point-in-time | Information actually available at the decision timestamp |
| Cohort | Explicit population being evaluated |
| Attribution | Evidence that a named change caused a measured difference |
| Shadow | Non-authoritative alternative collecting evidence only |
| Champion | Currently approved strategy configuration |
| Kill switch | Control blocking new risk while allowing risk reduction |

## 17. Abbreviations

| Abbreviation | Expansion | Meaning in Kairos |
|---|---|---|
| API | Application Programming Interface | A machine-readable endpoint used by Kairos or a provider |
| ATR | Average True Range | Volatility measure used in crypto/exit-geometry research |
| AV | Alpha Vantage | A market-data provider; its quota is centrally enforced |
| BO | Bombay Stock Exchange | Exchange suffix used by some Indian symbols |
| DB | Database | Supabase Postgres persistence layer |
| DDL | Data Definition Language | SQL that creates or changes tables, indexes or functions |
| DQ | Data Quality | Completeness, freshness and validity checks on evidence |
| EOD | End of Day | Completed market-session data, not an intraday partial bar |
| EMA | Exponential Moving Average | Price trend indicator used by technical research |
| ETF | Exchange-Traded Fund | A listed fund traded like a stock; it has different applicable dimensions |
| ET | Eastern Time | US market clock used for NYSE/Nasdaq schedules |
| FDR | False Discovery Rate | Multiple-testing control for research findings |
| GDELT | Global Database of Events, Language and Tone | News/event source used in bounded evidence collection |
| HAC | Heteroskedasticity and Autocorrelation Consistent | Robust uncertainty adjustment for dependent returns |
| IC | Information Coefficient | Rank correlation between a signal and later return |
| ID | Identifier | Stable key linking a signal, event, lot or run |
| INR | Indian Rupee | Currency of the India paper/live book |
| IST | India Standard Time | India market clock |
| JSON | JavaScript Object Notation | Structured payload format used in APIs and evidence fields |
| JWT | JSON Web Token | Auth token used by Supabase sessions |
| LLM | Large Language Model | Model used for evidence summaries or controlled agent prose |
| MACD | Moving Average Convergence Divergence | Technical momentum indicator; currently measure-only unless gated |
| MAE | Maximum Adverse Excursion | Worst excursion against an entry before exit |
| MCP | Model Context Protocol | Tool bridge used for broker capability and account operations |
| MFE | Maximum Favorable Excursion | Best excursion in favor of an entry before exit |
| NAV | Net Asset Value | Cash plus marked value of an isolated portfolio |
| NSE | National Stock Exchange of India | Primary exchange/calendar context for the India book |
| NIFTY | NSE Nifty 50 | India benchmark index used in market-local comparisons |
| OCO | One-Cancels-the-Other | Paired protective orders; never assumed available without broker proof |
| OHLCV | Open, High, Low, Close, Volume | Standard candle/bar fields |
| OOS | Out of Sample | Data not used to fit or choose a strategy |
| P&L | Profit and Loss | Realized or unrealized financial result |
| PIT | Point in Time | Evidence available no later than the decision timestamp |
| PKCE | Proof Key for Code Exchange | OAuth authorization protection used in broker connection flows |
| R:R | Risk-to-Reward | Relationship between stop distance and target distance |
| RLS | Row Level Security | Postgres policies limiting which users can read/write rows |
| RPC | Remote Procedure Call | Database function invoked atomically by an API route |
| RSI | Relative Strength Index | Bounded momentum indicator used in technical research |
| SQL | Structured Query Language | Database query language |
| T-stat | t-statistic | Estimate divided by its uncertainty; used to qualify evidence |
| UI | User Interface | Visible dashboard/page layer |
| USD | United States Dollar | Currency of the US and crypto paper books |
| UTC | Coordinated Universal Time | Canonical scheduler and crypto-session clock |
| Vercel | Vercel deployment platform | Hosts the deployed Next.js application |
| W/L/BE | Win / Loss / Breakeven | Closed-trade outcome categories |
