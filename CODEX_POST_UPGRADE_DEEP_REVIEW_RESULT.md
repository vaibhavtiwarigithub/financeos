# Kairos Post-Upgrade Deep Review — US/India Quant, Agents, Learning and Breakout Detection

**Date:** 2026-07-10  
**Verdict:** material engineering progress, but not ready for autonomous live trading and not yet a credible market-beating/self-evolving system.

This review extends the scoped remediation report in `CODEX_REMEDIATION_REVIEW_RESULT.md`. It evaluates the complete research → scoring → paper/live → outcome → learning loop, US/India parity, formulas, discovery universe, and the requested Micron/Intel/SanDisk versus meme-breakdown behavior.

## 1. What Claude actually improved

- Manual and autonomous order callers now share a common execution service (`lib/trading/execute-order.ts:77-337`). This is the correct architectural direction.
- Signal-query errors are no longer swallowed (`lib/trading/autonomous-live.ts:241-264`).
- US and India NAV acquisition is separated (`lib/trading/autonomous-live.ts:152-189`).
- The original calibration leakage was repaired by fitting each fold on its own training set (`lib/validation/calibration.ts:68-115`).
- Learner challengers now begin from the market champion when present and renormalize (`app/api/agents/learner/route.ts:468-530`).
- Positive `score_source` allowlists replaced negative filters in paper/trader (`app/api/agents/paper-trade/route.ts:147-158`; `app/api/agents/trader/route.ts:155-167`).
- Weighted structural evidence confidence is calculated on the decision observation (`lib/research-agent.ts:1321-1387`).
- Technical scoring is continuous around RSI rather than bucket-cliff based (`lib/data/technicals.ts:98-166`).
- A live market/session guard, cancel-on-kill attempt, and a US exit monitor were added.
- Route auth and some RLS policies improved; vault PINs use salted scrypt.

These are real improvements. They do not substantiate the claim that the whole target upgrade is implemented.

## 2. Full-system blockers and gaps

### P0 — blocks autonomous live or corrupts money safety

1. **Live schema remains unreproducible and RPC permissions are unsafe.** See remediation findings R1.
2. **Autonomy still has a zero-confidence dead-end.** ResearchAgent does not populate the signal column selected by auto; the real confidence exists on `decision_observations`.
3. **L4 and `live_approved` are not enforced.** A deterministic v1 signal can be auto-traded at the manual L3 autonomy level.
4. **India per-order sizing still mixes currency.** USD cap is applied numerically to INR NAV.
5. **Live risk controls measure paper P&L.** They cannot reliably stop real-money drawdown.
6. **The Robinhood adapter uses an unofficial/private REST workaround instead of Trading MCP.** Robinhood officially exposes `review_equity_order`, `place_equity_order`, `get_equity_orders`, and `cancel_equity_order` through its Trading MCP ([official tool list](https://robinhood.com/us/en/support/articles/trading-with-your-agent/)); the company explicitly describes MCP as the supported connection ([overview](https://robinhood.com/us/en/support/articles/agentic-trading-overview/)).
7. **Protective exits can oversell through duplicate proposals and stop when the kill switch/auto toggle is off.** India has no live protective exit.
8. **Cancel-on-kill cancels protective SELLs and mishandles partial-fill/cancel races.**

### P1 — prevents trustworthy alpha or self-evolution

9. **The actionable US “momentum screener” does not screen momentum.** It filters revenue growth, earnings growth, gross margin, ROE and market cap only (`lib/research-agent.ts:346-365`). It has no 12–1 return, relative strength, 52-week-high proximity, breakout, volume, earnings revision, surprise, or volatility filter. Results are unsorted/provider-order dependent and only six enter the daily candidate pool (`:367-381`).
10. **US coverage is not broad-market research.** Daily research examines holdings, watchlist, up to six screener names, metals and region ETFs (`lib/research-agent.ts:393-519`). A stock not already known or returned in the provider's first results is invisible. Edge Lab's broad list is measure-only and does not feed selection.
11. **India discovery is stale/extreme-first.** Candidate selection reads up to 1,500 cached rows without a `scored_at` freshness predicate, then chooses the highest RSI>60 or lowest P/E (`lib/research-agent.ts:538-570`). It does not require liquidity, volume, market cap, spread, earnings quality, debt, revisions, or price/volume confirmation. Full-NSE cache rotates only 600 names per run, so a complete refresh takes several nights (`app/api/scan/india/refresh/route.ts:14-31,47-64`).
12. **Cross-sectional rank is display/evidence only.** The rank is computed after symbols are already selected/scored and neither paper nor live eligibility requires it (`app/api/agents/research/cron/route.ts:189-213`; consumers only order raw `analyst_score`). Therefore the system does not choose the best symbol from the eligible US/India universe.
13. **“Setup experts” are static reweightings of the same five coarse dimensions.** PEAD has no SUE/revision/guidance feature; value inflection has no change/inflection variable; sector rotation has no sector-relative return input (`lib/scoring/archetypes.ts:16-95`). They remain shadow rows and are not genuine specialist models.
14. **Feature Registry and Edge Lab still do not change decisions.** Active registry features are logged only (`lib/research-agent.ts:1293-1319`), and static-universe Edge IC is measure-only/survivorship-biased (`lib/edges/universe.ts:1-12`; `lib/edges/ic.ts:163-173`).
15. **Learning is still one-coordinate correlation nudging, not policy evolution.** The LLM proposes a weight after a univariate correlation with N≥10 and calls absolute correlation “confidence” (`app/api/agents/learner/route.ts:440-466`). It cannot learn the universe, subfeatures, formula shapes, routing, or real setup models. Correlated dimensions and repeated testing can generate false discoveries.
16. **Promotion governance still has `force_unvalidated` and unscoped-demotion fallback.** (`app/api/strategies/versions/route.ts:55-100`). This was not remediated.
17. **Calibration deploys without an OOS acceptance gate.** Fold-local calculation is honest, but the full-history artifact is stored and used even with empty/poor OOS calibration (`lib/validation/calibration.ts:91-145`).
18. **No point-in-time fundamentals/revisions/universe.** Current provider overview values and static/current universes cannot recreate what the system knew before a historical rally. This prevents a valid claim that it would have detected a past winner.

## 3. Formula audit

### Fundamental score

Current formula starts at 50 and additively applies sector-normalized P/E, margin, ROE, EPS sign, one YoY revenue-growth value, and analyst-target upside (`lib/data/scores.ts:73-157`). Problems:

- **Missing subfeatures change the score rather than only uncertainty.** A stock with two fields is considered available (`:37-51`) but is scored on fewer opportunities to gain/lose points. Normalize within the fundamental dimension by applicable subfeature weights and track coverage.
- **Hardcoded sector P/E norms are not point-in-time, market-specific medians** (`:54-70`). India and US sector valuation distributions differ; cyclical semiconductors often appear cheapest near peak earnings and most expensive near trough.
- **ROE is leverage/equity-base sensitive.** Negative or tiny book equity can make it misleading. Add ROIC, gross profitability, leverage, interest coverage and bankruptcy/quality controls.
- **Revenue growth is a level, not acceleration.** The examples the owner cares about were inflections: sequential segment growth, pricing/mix, guidance revisions, and estimate revisions. None are calculated.
- **Analyst target upside is a lagging, endogenous signal** (`:137-150`). It can penalize a winner merely because price caught up before analysts revised targets. Revision direction/breadth and target-change velocity are more defensible than static upside.
- **No earnings quality.** Accruals, cash conversion, inventory/receivables growth, FCF margin, dilution and one-offs are absent. Research shows high accruals accompany weaker future returns ([NBER earnings-quality study](https://www.nber.org/papers/w8308)).
- **No sector-specific cycle model.** Memory/semiconductor detection needs DRAM/NAND pricing, inventory days, capex/supply discipline, datacenter mix, gross-margin inflection and guidance delta. Bank/commodity/utility formulas require different primitives.

Recommended fundamental contract: each setup expert receives timestamped raw features, computes sector/market cross-sectional ranks, change/acceleration features, quality and valuation separately, then emits expected excess-return distribution and uncertainty. Do not make one universal additive score carry every industry.

### Technical score

Current formula uses RSI14, price versus EMA20/50, a categorical 20-day return, and one-day volume ratio (`lib/data/technicals.ts:15-95,117-166`). It is deterministic and continuous, but insufficient for breakout and crash discrimination:

- no 6–12 month momentum excluding the latest month;
- no relative strength versus sector/benchmark;
- no 52-week high proximity/resistance breakout;
- no ATR/realized volatility or volatility-adjusted momentum;
- no gap size, close location, intraday reversal, downside volume, or failed-breakout measure;
- no trend quality/consistency, moving-average slope, ADX, or breadth confirmation;
- one-day volume is treated as bullish whenever either EMA20 or 20-day trend is bullish; conflicting conditions receive no penalty (`:149-163`).

**Targeted exact-formula stress test:** I replicated `scoreTechnicals` from the source. After a smooth parabolic sequence, the score was 78. Appending a **−12% high-volume reversal** produced score **100**: RSI fell from 100 into the preferred band, price remained barely above EMA20 and well above EMA50, the 20-day trend stayed positive, and high volume was called bullish. A slower uptrend followed by −6% still scored 76 because bullish and bearish flags conflicted and volume applied no penalty. This is precisely the meme/fast-breakdown trap the owner asked to avoid.

Fix with a separate deterministic breakdown veto evaluated before momentum score: large negative gap/return relative to ATR; close in bottom quartile; volume shock; loss of breakout/EMA; failed-breakout gap retention; volatility explosion; and price/volume divergence. It should quarantine/exit, not merely subtract a few points. Validate thresholds prospectively and by market liquidity bucket.

### Sentiment

StockTwits score is `bull/(bull+bear)` with no message-count shrinkage (`lib/data/scores.ts:162-184`). One bullish message can score 100. Social excitement can therefore reinforce meme crowding. Use Bayesian shrinkage to neutral by sample size, bot/source quality, novelty, velocity, disagreement, and price-confirmation; cap sentiment contribution for new entries and add a crowding/reversal-risk feature. India sentiment is structurally absent, so do not pretend parity.

### Macro

One global MacroSentinel danger score becomes `100-danger` for every stock (`lib/data/scores.ts:203-254`). The same US-centric regime is applied in the India pipeline. It has no rate/beta/sector sensitivity and can dominate all symbols equally without changing their cross-sectional ranking. Build separate US and India macro state with vintages, then map exposures by setup/sector; initially use it as exposure scaler, not universal alpha.

### Insider

Insider activity is useful only with transaction type, role, cluster, size relative to holdings/compensation, and subsequent price context. The current coarse 0–100 dimension and provider availability do not establish those controls. It should be a sparse event feature with explicit “no data” state, not a routinely renormalized equal dimension.

### Composite score and sizing

- A 0–100 weighted average is not expected return or win probability. `conviction` mirrors it (`lib/research-agent.ts:1175-1180`), compounding the semantic error.
- Profile weights are selected before global signal weights, so `signal_weights` is effectively unreachable whenever a normal profile exists (`lib/research-agent.ts:982-1008`). Only champion weights truly change scoring.
- A promoted genome changes some paper behavior, but autonomous live sizing uses separate global config and mixed-trade Kelly; the policy is not one coherent version.
- No live volatility targeting exists. Evidence-bound Kelly on as few as ten mixed trades plus flat fallback is far below institutional risk practice. Volatility management is a distinct risk benefit documented in the literature ([RFS risk-management review](https://academic.oup.com/rfs/article/31/7/2729/5001472)).

## 4. Could Kairos have detected MU, INTC and SNDK early?

### Honest answer

**Not reliably, and the repository cannot prove that claim.** It might catch some names after trend confirmation, but it lacks the point-in-time data and specialist features needed to show prospective early detection.

I ran an illustrative price-only replay using adjusted daily Yahoo candles and the exact current technical formula. For each symbol I located the first date since 2024 followed by at least +30% over 60 trading days:

| Symbol | Illustrative date | Forward 60d return | Current technical score on date | Interpretation |
|---|---:|---:|---:|---|
| MU | 2024-03-14 | +47.6% | 70 | Technical score could flag an already-forming trend, **if MU entered the six-name daily universe**. |
| INTC | 2024-08-14 | +31.7% | 0 | Current trend formula would reject the early contrarian/turnaround point. It needs fundamental inflection/catalyst evidence and later confirmation. |
| SNDK | 2025-04-28 | +30.3% | 5 | Current formula would reject the early post-separation/downtrend point. SNDK is also absent from `US_LIQUID`; only watchlist/provider screener could discover it. |
| GME | 2024-03-14 | +69.7% | 77 | The same formula can favor a future meme spike; it does not distinguish durable fundamental trend from squeeze/crowding. |

This is **not** a valid strategy backtest: the universe and fundamentals are not point-in-time, and choosing dates by future return is intentionally diagnostic. It demonstrates why Claude cannot claim the fix detects these rallies.

Public information existed that a better event/fundamental model could have captured. Micron raised FY2025 Q4 guidance based on improved DRAM pricing ([Micron release](https://investors.micron.com/news-releases/news-release-details/micron-updates-fourth-quarter-fiscal-2025-guidance)); Sandisk reported sequential revenue growth, datacenter acceleration and forward guidance ([Q1 FY2026](https://investor.sandisk.com/news-releases/news-release-details/sandisk-reports-fiscal-first-quarter-2026-financial-results), [Q2 FY2026](https://investor.sandisk.com/news-releases/news-release-details/sandisk-reports-fiscal-second-quarter-2026-financial-results)); Intel later reported revenue acceleration and product/foundry milestones ([Intel Q1 2026](https://www.intc.com/news-events/press-releases/detail/1767/intel-reports-first-quarter-2026-financial-results)). Kairos does not structurally ingest guidance delta, estimate revisions, segment acceleration, pricing cycle, or catalyst novelty. An LLM narrative cannot substitute for timestamped numeric features.

### Required durable-breakout expert

Build and validate a **quality/catalyst momentum expert**, not another static weight vector:

- universe: liquid names with minimum price, ADV, spread, history and tradability;
- 12–1 and 6–1 momentum, 1/3-month sector-relative strength, 52-week-high proximity;
- breakout above prior resistance with multi-day volume confirmation;
- revenue/EPS/gross-margin acceleration and positive guidance delta;
- analyst EPS/revenue revision breadth and magnitude;
- earnings surprise/SUE and post-gap retention;
- FCF/accrual/inventory/receivable quality;
- volatility-adjusted strength, downside beta and gap risk;
- catalyst timestamp/novelty and evidence provenance;
- market/sector breadth and trend favorability as exposure scalers.

For memory semiconductors, add a validated sector module for DRAM/NAND pricing, inventory, utilization/capex, datacenter/HBM/SSD mix and gross-margin revisions. For Intel-like turnarounds, use a separate inflection expert; do not force a downtrend turnaround through a trend score.

### Required meme/crowding defense

- liquidity/float/short-interest/borrow and retail-message velocity where legally/reliably available;
- parabolic acceleration and distance from medium-term trend;
- gap/reversal/failed-breakout veto described above;
- volatility-targeted sizing with a much lower cap for crowding/uncertainty;
- no market order in abnormal spread/volatility;
- broker-native protective stop or continuously monitored tested protection;
- gap-risk acknowledgement: stops cannot guarantee exit price;
- fast score decay and re-evaluation after abnormal move;
- never use bullish social ratio as confirmation without sample/crowding adjustment.

Momentum is a real historical effect, but it has severe crash risk ([NBER momentum-crash evidence](https://www.nber.org/papers/w20660)). The solution is not to avoid every high-momentum stock; it is to separate durable, quality-supported momentum from lottery/crowding exposure and size/exit accordingly.

## 5. US and India parity

| Capability | US | India | Verdict |
|---|---|---|---|
| Broad discovery | FD first-page dual bucket + watchlist; not broad PIT | Rotating NSE cache, up to 600/night | Both incomplete; India broader but stale/extreme-first. |
| Fundamentals | Alpha Vantage/FinancialDatasets | Yahoo mapping | Different field coverage/quality; same formula is not equivalent. |
| Technicals | AV/Massive/cache | Yahoo/AV/cache | Shared formula, but quote staleness uses US hours. |
| Sentiment | StockTwits + AV news | excluded | Honest non-parity; weights renormalize. |
| Macro | US MacroSentinel | same global score | Wrong parity; India needs RBI/inflation/INR/flows/market state. |
| Insider | AV/EDGAR-like feeds | sparse/other route | Not comparable. |
| Paper | Implemented per-market pools/caps | Implemented | Better parity, still uses heuristic score. |
| Manual live | Robinhood/Alpaca adapters | Kite | Broker integrations differ; Robinhood direct path unsupported. |
| Autonomous live entry | Present but blocked/unsafe | Present but currency/quote issues | Keep off. |
| Autonomous live exits | US-only unsafe monitor | absent | Hard failure. |
| Tax/dividend | Not integrated into optimization | India tax differs substantially | Advisory fragments are not a tax-aware portfolio/execution layer. |

## 6. Agent-flow and evolution assessment

| Mechanism | Writes evidence | Changes behavior | Assessment |
|---|---:|---:|---|
| ResearchAgent deterministic five-score | Yes | Yes | Real but coarse; discovery bottleneck dominates. |
| ThemeScout | Watchlist | Indirect | US news themes only; no measured incremental alpha gate. |
| MacroSentinel | Macro rows | Same scalar for all | Advisory/global, not market-specific specialist. |
| Archetypes | Shadow decisions | No | Static reweights, not expert models. |
| EdgeScout/IC | Edge tables | No | Useful lab, still survivorship/multiple-testing limited. |
| Feature Registry | Registry/history | No | Logged-only. |
| Label maturation | Labels | Feeds learner/models | Real closed loop; session/PIT integrity remains essential. |
| Calibration | Model artifact | Paper sizing | Connected, but no OOS deployment gate. |
| Learner weights | Challenger | After owner promotion | Connected but weak credit assignment and tiny genome. |
| Genome | Strategy version | Paper entry/sizing/exits | Partial; live path does not consume one coherent version. |
| Performance truth | Evaluations | Advisory | Necessary, not a promotion/control plane. |
| Autonomous live | Orders | Intended | Current blockers make it unsafe/dead-ended. |

The app self-records extensively and has two genuinely connected loops (champion weights and paper genome), but it does not yet self-evolve the feature set, specialist models, universe, expected-return model, or portfolio policy. Calling it “world-class self-evolving” today is inaccurate.

## 7. Comparative scorecard

Scores are against a high bar: an institutional-grade, point-in-time, reproducible, agent-assisted systematic platform—not against a typical hobby dashboard.

| Dimension | Score /10 | Why |
|---|---:|---|
| Safety architecture design | 6.0 | Strong intended gates and shared-service direction; critical implementation defects remain. |
| Live-money implementation | 2.0 | Unsupported RH path, incomplete schema, wrong live kill data, unsafe exits, no India exits. |
| US discovery/universe | 3.5 | Narrow provider result/watchlist pipeline; “momentum” screen lacks momentum. |
| India discovery/universe | 4.0 | Full-NSE rotation is promising, but stale, liquidity-blind and extreme-first. |
| Feature/scoring quality | 4.0 | Deterministic/provenance-aware, but coarse heuristic additive model and weak specialist features. |
| Statistical validation | 4.5 | Purged folds and corrected calibration are good; PIT, multiple testing, deployment gates and baselines incomplete. |
| Self-learning/evolution | 4.0 | Champion/genome loops partly close; registry/edges/archetypes do not evolve live behavior. |
| Portfolio/risk construction | 4.5 | Paper constraints exist; live risk uses paper data and sizing is not volatility/forecast based. |
| US/India separation | 4.0 | Many market fields exist; macro, Kelly, cap and quote bugs still cross-contaminate. |
| Explainability/audit | 6.5 | Strong journals/evidence concept; order-event durability incomplete and semantics drift. |
| Security/Supabase | 4.5 | Auth improved; RLS inventory incomplete, RPC grants unsafe, secrets plaintext. |
| Testing/operational resilience | 3.5 | 142 pure tests; essentially no money-path/DB/chaos/E2E coverage; build unverified. |
| **Overall** | **4.2/10** | A serious prototype/governed research platform, not ready to claim autonomous or market-beating capability. |

No platform can promise to beat the best traders in every condition. The credible target is prospective, net-of-cost benchmark outperformance under explicit drawdown limits, with safe abstention and faster governed adaptation than model decay. Backtest complexity generally deteriorates sharply live; one published study found a median 73% Sharpe deterioration across marketed alternative-beta strategies ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2757113)). Multiple-testing-aware metrics such as Deflated Sharpe are required ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551)).

## 8. Required fix order

1. Keep autonomous flag false; repair migration/RPC grants and add clean-reset tests.
2. Replace signal confidence with immutable decision-quality join; enforce L4 and `live_approved` in the gateway.
3. Remove unofficial Robinhood REST execution; implement official remote MCP client + review/place/status/cancel schema validation.
4. Separate live risk from paper risk and make every market/account/currency explicit.
5. Rebuild live exits from broker positions with atomic symbol claims, partial-fill math, broker-native protection, and India support. Exits survive auto-disable/kill.
6. Add execution/SQL/concurrency/chaos tests before any canary.
7. Repair discovery: deterministic sorted broad eligible universes, freshness/liquidity, market-specific feature availability.
8. Build quality/catalyst momentum and turnaround experts in shadow with PIT data; add breakdown/crowding veto.
9. Make cross-sectional rank/expected return drive portfolio selection only after honest walk-forward/lockbox validation.
10. Replace correlation nudging with regularized, setup/market/horizon-specific champion–challenger tournaments; remove unsafe promotion fallback.
11. Complete RLS/secrets hardening and consolidate exchange calendars/schedulers.
12. Run a prospective shadow period, paper E2E, clean DB replay, broker sandbox/canary, and kill/cancel drill before the first autonomous dollar.

## 9. Verification performed

- Traced current remediation commits through shared execution, autonomous entry, broker adapters, sync/cancel, live exit, calibration, learner, scoring, discovery and migrations.
- Ran `npm test`: **19 files, 142 tests, all passed**.
- Ran `npm run build`: **timed out after 184 seconds without a result**; build is not verified green.
- Ran exact-formula synthetic breakdown stress cases; reproduced 76–100 scores after material reversals.
- Ran an illustrative adjusted-price replay for MU/INTC/SNDK/GME/AMC to test whether the current technical formula could identify early points. This was diagnostic, not a valid backtest.
- Reviewed current primary/official Robinhood MCP documentation and company/SEC disclosures for the example companies.

