# Codex Review — Momentum Factors + Trade-Behavior Mirror

**Date:** 2026-07-10  
**Reviewer:** ChatGPT/Codex, adversarial quant-systems review  
**Scope:** architecture and current-code reality; no production implementation

## Executive verdict

The motivation is directionally correct, but both proposals overstate what the current infrastructure proves.

- The claim that Kairos “structurally fades multibaggers” is plausible but **unproven**. The RSI curve does penalize RSI above 75 and the fundamental score penalizes high relative P/E, but remembered winners are a survivorship-selected anecdote. Prove the conditional opportunity cost before changing production scoring.
- Option B as written is **not an implementation path**. The current Feature Registry evaluates active formulas and logs them under `decision_observations.features.active_feature_values`; it does not inject them into technical/fundamental scores. EdgeIC and Feature Registry are also separate mechanisms. Promoting a registry row does not make a factor tradable.
- The newly built archetype layer does not solve this yet. `lib/scoring/archetypes.ts` only applies different static weights to the same five legacy dimension scores; its `quality_momentum` expert has no relative strength, 52-week-high, volatility-adjusted path, or earnings-revision input. It is a shadow weighting experiment, not a momentum model.
- A new sixth “momentum” weight is also the wrong long-term architecture. Relative strength, 52-week-high proximity, and breakout/volume are a correlated trend family. Give that family a versioned setup expert, not another freely learned dial.
- The behavior mirror is useful only after the raw transaction ledger is repaired. Today’s CSV parser and enrichment are not reliable enough for behavioral claims: naive CSV parsing, destructive symbol remapping, ambiguous `SHR` classification, calendar-day horizons, adjusted/unadjusted price mixing, hardcoded macro narratives, and no position/lot episode reconstruction.
- Historical personal trades must remain coaching evidence only. They are selected by the owner’s past beliefs and opportunity set and are not a valid alpha-training sample. The existing Learner prompt correctly quarantines them from weight changes; keep that boundary.

The right order is: **prove/kill the fade premise → repair historical transaction truth → compute shadow price-trend family → validate it on a PIT broad universe and the correct horizons → add a momentum setup expert in shadow → build descriptive behavioral episodes and confidence intervals → only then narrate.**

---

## 1. Ranked dangerous assumptions and concrete fixes

| Rank | Severity | Wrong assumption | Why it is dangerous | Concrete fix |
|---:|---|---|---|---|
| 1 | CRITICAL | “Feature Registry promotion means the factor can feed an existing score.” | False in current code. `lib/research-agent.ts:1293-1319` explicitly logs active feature values and says “never score with.” `app/api/validation/feature-check/route.ts` changes registry lifecycle, but no production scorer consumes those values. Option B silently stops before the claimed outcome. | Use Feature Registry/EdgeIC for discovery only. After evidence, create a new versioned `quality_momentum`/`momentum_breakout` setup scorer whose explicit input contract includes the promoted feature family. Shadow it, validate champion-vs-challenger, then owner-promote. Do not splice formulas invisibly into legacy dimension totals. |
| 1B | CRITICAL | “The existing `quality_momentum` archetype is already the momentum architecture.” | False. `lib/scoring/archetypes.ts` calls `computeWeightedAnalystScore()` over the same five legacy dimensions and merely gives technical 40%. It contains none of the proposed momentum features and inherits the RSI>75 fade inside `technical_score`. A different label/static weight vector does not create a different alpha model. | Keep these rows measure-only and rename/document them as five-dimension weighting shadows until they have real setup inputs. Implement the eventual expert against a versioned feature contract and store its raw family contributions, gates, and score separately. |
| 2 | CRITICAL | “The broad EdgeIC gate removes survivorship and overfitting.” | Current `edge_universe_members` is explicitly non-PIT/static. `lib/edges/ic.ts` uses today’s resolved symbols historically, accepts cross-sections as small as five, and marks an edge shadow-eligible if **any** tested horizon clears. This leaves survivorship, horizon shopping, and multiple-testing bias. | Persist effective-dated universe membership by date; require liquidity/price/seasoning rules using only then-known data; pre-register factor family, sign, horizons, and transformations; evaluate on a locked holdout; correct for family-wise trials/FDR; require stability across subperiods and markets rather than “any horizon wins.” |
| 3 | CRITICAL | “The behavior mirror can start with technical enrichment on current `trade_decisions`.” | The underlying transaction truth is not reliable. `import-csv/route.ts` splits CSV rows on commas, maps historical acquired/delisted symbols to current tickers, treats `SHR` as BUY, stores date but not timestamp/transaction ID/fees/amount, and deduplicates potentially legitimate partial fills. Indicators computed on this base will look precise while describing the wrong trades. | Build a raw immutable import layer first. Use an RFC-4180 parser; preserve original row, original symbol, instrument/transaction ID, exact timestamp/time zone, activity code, quantity, price, amount, fees, and source hash. Classify equity BUY/SELL only through an explicit transaction-code table; quarantine transfers, options, dividends, splits, mergers, ACATS, assignments, and unknown codes. Reconstruct normalized fills separately. |
| 4 | CRITICAL | “Current forward outcome enrichment is a valid decision score.” | It is not. `enrich/route.ts` uses calendar days, searches both forward and backward around target dates, compares CSV execution price with adjusted future close, ignores dividends/fees, and uses a hand-labeled macro chronology. A split between trade and horizon can create absurd returns. A SELL being followed by a decline is not automatically a good decision if proceeds missed a stronger alternative or the row is one leg of rebalancing. | Replace with exchange-calendar trading horizons and total-return-consistent price bases. Use the first session **on or after** each target horizon, never a prior date. Adjust the execution price to the same corporate-action basis or use unadjusted prices plus explicit distributions. Store each horizon return separately, benchmark/sector-relative, with provenance. Remove the single `outcome_score` as behavioral truth; derive question-specific metrics. |
| 5 | HIGH | “The scorer fades multibaggers.” | The mechanical effect exists, but the performance claim is hindsight. RSI >75 is penalized, yet EMA/trend/volume may keep technical score high; P/E is only one part of fundamentals and may be excluded/offset. The remembered list contains winners known after the fact and ignores high-RSI/high-P-E failures. | Run the pre-registered counterfactual test in §4 on the entire observable opportunity set, not selected winners. Compare high-RSI candidates to matched 60–72 RSI candidates conditional on liquidity, sector, market, volatility, prior return, and data availability. Measure both score suppression and subsequent benchmark-neutral returns. |
| 6 | HIGH | “Six momentum/growth factors are six independent edges.” | RS, 52-week-high proximity, medium-term momentum, and breakout are transformations of the same price path. Volume breakout is usually confirmation/interaction, not a standalone directional factor. Revenue acceleration, EPS acceleration, estimate revision, and post-earnings drift are another event/fundamental-momentum family. Treating them independently multiplies trials and double-counts trend. | Define two families: **price trend** (12–1/6–1 momentum, benchmark/sector RS, 52w high, vol-adjusted path; volume/liquidity as interaction/gate) and **fundamental/event momentum** (standardized surprise, revision breadth/magnitude, guidance/revenue corroboration). Test incremental/conditional IC, feature correlations, top-K overlap, and ablation. Keep one composite/expert per family unless incremental OOS value is proven. |
| 7 | HIGH | “Historical estimate revisions can be fetched like ordinary fundamentals.” | Current/latest consensus is not point-in-time history. Vendor backfills, contributor-set changes, restatements, and publication latency leak future knowledge. Target-price revisions are especially subjective and sparse. Alpha Vantage current endpoints do not establish an as-known-then revision tape. | Require a vendor dataset containing estimate value, fiscal period, consensus statistic, contributor count, `as_of`, and first-available timestamp with historical vintages. Store raw snapshots and hashes. Validate sample coverage/latency. If unavailable, do not reconstruct revisions; use filed earnings/revenue surprises with SEC/vendor `accepted_at` timestamps and mark revisions `unavailable`. |
| 8 | HIGH | “Quarterly second derivatives identify cycle turns.” | Four to eight observations with reporting noise, seasonality, acquisitions, FX, one-offs, and revisions make a raw second derivative unstable. It will select accounting noise and then look brilliant on a few remembered cyclicals. | Prefer robust, interpretable event features: YoY growth change versus the prior YoY rate, standardized unexpected earnings/revenue, revision breadth, and corroboration across revenue/earnings/guidance. Winsorize cross-sectionally, require multiple available quarters, and test stability. Keep raw second derivative research-only unless it adds OOS conditional IC. |
| 9 | HIGH | “2/5/10/20-day IC validates a multimonth thesis.” | Horizon mismatch. It can validate a swing entry continuation signal, not the claim that the stock becomes a multibagger. Optimizing a 6–12 month feature on 5-day outcomes may reject a real slower edge or select a short-lived jump. | Separate mandates. For the current swing system test 5/10/20 trading-day entry edge and realized strategy P&L. Add 60/120/252-day research labels for secular/cycle thesis, with non-overlap/effective-sample corrections. Do not let long-horizon research directly drive the 2–20d live setup. |
| 10 | HIGH | “Champion weights can learn the momentum tilt from tens of trades.” | No. Five/six weights, thresholds, genome parameters, correlated outcomes, and regime dependence overwhelm tens of fills. Trade-only learning selects on the strategy’s own past choices and has low effective N. | Learn feature direction/shape from the broad opportunity ledger, not fills. Use regularized/prior-fixed setup weights in shadow. Paper/live fills confirm economic performance and execution. Require effective independent observations and champion-vs-challenger OOF evidence before promotion. |
| 11 | HIGH | “Historical P/E = historical price × historical EPS/earnings.” | The formula is underspecified and can be wrong. P/E is price / contemporaneous TTM diluted EPS. Per-share values must share the same split basis; filings must be the latest accepted **before** the trade; quarterly versus TTM, fiscal-period alignment, negative EPS, amended filings, and restatements matter. Current-vintage historical statements are not necessarily as-known-then. | Select the latest accepted filing at or before trade timestamp; compute TTM diluted EPS from four then-available quarters, or use as-reported TTM EPS with explicit vintage. Match split basis. Record accession/filing/accepted timestamps, fiscal periods, units, and vintage quality. If only latest-restated history exists, label `reconstructed_latest_vintage`, never `pit`. |
| 12 | HIGH | “Behavioral fingerprint metrics can be calculated per CSV row.” | Behavior lives in position episodes, not isolated fills. Multiple buys may be one accumulation; one sell may be a partial trim; transfers are not decisions; overlapping positions violate independence. “Average down,” “sell winners early,” and “panic sell” require reconstructed position state and market-relative counterfactuals. | Build a deterministic event-sourced position/lot engine. Group fills into episodes from flat→open→flat, retaining partial fills/lots. Calculate pre-trade weighted cost, unrealized P&L/drawdown, time since prior action, remaining quantity, MAE/MFE, benchmark return, and post-exit opportunity cost. Behavioral statistics operate on episodes or clearly defined decisions with clustered uncertainty. |
| 13 | MEDIUM | “Then versus now reveals behavior.” | “Now” is influenced by survival, acquisitions, changed business models, and the fact that only remembered/current symbols remain observable. It invites narrative hindsight. | Show then-vs-now only as descriptive context with original/canonical instrument lineage and explicit as-of timestamp. Never use it to score the historical decision or train alpha. Prefer then-versus-forward-horizon and then-versus-matched benchmark. |
| 14 | MEDIUM | “Mentor narration is safe because numbers are deterministic.” | A narrator can still overstate noisy statistics or causality. Small samples will be turned into confident personality claims. | Feed Mentor structured claims containing estimate, denominator, confidence interval, effective N, comparison baseline, status (`insufficient`, `exploratory`, `supported`), and forbidden-causality text. Require the narrative to repeat uncertainty and never diagnose mental state. |

---

## 2. Statistical rigor audit

### Leakage

- **Revision history:** unusable unless snapshots are genuinely historical with first-available timestamps.
- **Fundamentals:** statement period end is not availability. Use filing acceptance/publication time, and preserve vintage/restatement status.
- **Universe:** current constituent/static liquid lists applied backward create survivorship bias.
- **Feature transformations:** percentile ranks, winsorization, standardization, composite weights, and missing-value rules must be fit on the training/reference cross-section only.
- **Behavior outcomes:** `findClosestPrice()` currently permits a date before the intended horizon; calendar-day addition and adjusted/unadjusted price mixing contaminate labels.
- **Then-vs-now:** current data cannot enter historical behavior classification.

### Overfitting and multiple testing

The proposal is not six tests. It includes multiple lookbacks (1/3/6 months, 30/90-day revisions), definitions, thresholds, markets, horizons, sector/benchmark variants, interaction rules, and archetypes—dozens of effective trials. Record a `trial_family_id`, every attempted specification, and the locked primary metric/horizon. Use FDR/Deflated Sharpe or an equivalent documented correction. A factor passing one of four horizons is not sufficient.

### Effective sample size

- Cross-sectional rows on the same date share market/sector shocks; they are not independent.
- Overlapping forward returns reduce temporal effective N.
- Repeated fills in one symbol/episode are clustered.
- Tens of closed trades cannot support weight discovery or personality claims with useful precision.

Behavioral reporting policy:

| Effective independent episodes in a comparison | Allowed language |
|---:|---|
| `<20` | “Insufficient sample”; show raw counts only |
| `20–49` | “Exploratory tendency”; always show wide bootstrap/Beta-binomial interval |
| `≥50` | May say “evidence of a tendency” only if interval excludes the preregistered null and it is stable across time slices |

These are reporting floors, not universal proof thresholds. Strong clustering or category imbalance can require more.

### Horizon alignment

- Price trend family: 5/10/20d for the swing-entry mandate; 60/120d research only.
- PEAD/revision family: event time plus 5/20/60 sessions; exclude information released after the decision timestamp.
- Behavior: choose metric by question. “Good entry” and “good exit” need different counterfactuals; do not collapse them into one 1-month score.

### Metrics that must be reported

- date-level Spearman IC distribution, ICIR, Newey–West/block-bootstrap uncertainty;
- top-K precision and top-minus-median benchmark-neutral return;
- turnover, spread/slippage/fees, capacity/liquidity;
- conditional IC after the existing technical/fundamental baseline;
- feature-family correlation and top-decile overlap;
- subperiod, sector, size/liquidity, volatility, and US/India stability;
- champion-versus-challenger paired OOF economic results;
- all attempted variants and holdout untouched until final decision.

---

## 3. Exact test to prove or kill “Kairos fades multibaggers”

### Step 0 — data sufficiency diagnostic

Run this first. If RSI is missing from most observations, the existing ledger cannot answer the question and a historical replay is required.

```sql
select
  market,
  count(*) as observations,
  count(*) filter (where nullif(features->'technical'->>'rsi14','') is not null) as with_rsi,
  count(*) filter (where observation_labels.id is not null) as labeled
from decision_observations d
left join observation_labels on observation_labels.observation_id = d.id
group by market;
```

Use the real FK/column names from the applied label migration if they differ; do not weaken the test.

### Step 1 — measure mechanical suppression

For each PIT observation with technical evidence, recompute the v1 score twice from the **same snapshot**:

- factual score with current RSI curve and relative-P/E contribution;
- counterfactual score where RSI above 75 is capped at the 72 contribution and P/E penalty is removed only for the test.

Persist neither as production state. Calculate:

```text
suppression_bps_score = counterfactual_score - factual_score
entry_flip = factual_score < recorded_threshold AND counterfactual_score >= recorded_threshold
```

This proves whether the formula blocks candidates; it does not prove the block is harmful.

### Step 2 — test whether suppressed candidates outperform

Build the entire then-eligible opportunity set, including rejected/abstained names, from a PIT universe. Define the primary cohort before viewing results:

```text
treated: RSI >= 75, price > EMA50, rel_momentum_60d > 0, liquidity passes
control: RSI 60–72, price > EMA50, matched on market/date/sector,
         prior 60d return, realized vol, size/liquidity, and evidence confidence
```

Primary outcome: 20-trading-day sector/benchmark-neutral total return. Secondary: 5/10/60/120d. Cluster/bootstrap by date and symbol. Report matched difference, interval, N dates, N symbols, and entry-flip subset. Add the high-relative-P/E interaction only as a predeclared secondary test.

### Step 3 — falsification

The premise is killed if any of these hold:

- score suppression rarely flips eligibility;
- suppressed candidates do not outperform matched controls net of costs;
- effect exists only in the remembered 2023–2026 AI/memory cohort;
- effect disappears outside one sector, after liquidity/volatility matching, or on holdout dates;
- a simple positive relative-strength feature captures the effect and removing the RSI penalty adds no incremental OOS value.

### Minimal analysis query after the necessary PIT fields exist

```sql
with x as (
  select
    d.id, d.market, d.symbol, d.ts::date as decision_date,
    (d.features->'technical'->>'rsi14')::numeric as rsi14,
    (d.features->'technical'->>'rel_momentum_60d')::numeric as rel_mom_60d,
    d.analyst_score, d.score_threshold,
    l.horizon_days, l.benchmark_neutral_return
  from decision_observations d
  join observation_labels l on l.observation_id = d.id
  where l.horizon_days in (5,10,20,60,120)
    and d.market = 'us'
    and d.features->'technical'->>'rsi14' is not null
)
select
  horizon_days,
  case when rsi14 >= 75 then 'rsi_75_plus'
       when rsi14 >= 60 then 'rsi_60_72'
       else 'other' end as cohort,
  count(*) as n,
  avg(benchmark_neutral_return) as mean_bn_return,
  percentile_cont(0.5) within group (order by benchmark_neutral_return) as median_bn_return,
  avg((analyst_score < score_threshold)::int) as rejected_rate
from x
where rel_mom_60d > 0
group by horizon_days, cohort
order by horizon_days, cohort;
```

This SQL is diagnostic, not causal proof. The matched/date-clustered replay is the decision test.

---

## 4. Missing pieces

### Momentum/growth

- PIT/effective-dated universe, delisting returns, symbol lineage, and corporate-action-adjusted candles.
- Separate benchmark and sector-relative returns; broad-market RS alone can confuse sector beta with stock alpha.
- Liquidity/spread and capacity gates; high apparent momentum among illiquid names may not be executable.
- Feature-family correlation/ablation and trial registry.
- Explicit event timestamps and after-hours handling for earnings/revisions.
- Revision coverage, contributor count, dispersion, fiscal-period mapping, and stale-consensus detection.
- Distinction between surprise, revision, acceleration, trend, and valuation rerating.
- A locked scoring/setup version and activation lifecycle; Feature Registry `active` is not trading approval.
- 60/120/252-day research labels if the thesis remains “multibagger,” kept separate from swing execution.
- Net-of-cost portfolio simulation. IC alone does not establish a profitable long-only strategy.

### Trade-behavior mirror

- Immutable raw CSV/file rows and parser-version/provenance.
- Owner gate on import; current import checks any authenticated user rather than `requireOwner()`.
- Full transaction taxonomy and asset type; options/assignments/transfers/dividends/splits/mergers excluded until supported.
- Original symbol/instrument lineage; never rewrite historical TWTR as X or ATVI as MSFT for price lookup.
- Exact timestamp/time zone and exchange session mapping.
- Corporate actions, fractional shares, partial fills, fees, distributions, and cash movements.
- Event-sourced position/lot reconstruction and episode IDs.
- Total-return-consistent outcome labels and benchmark/sector counterfactuals.
- Append-only enrichment versions. Current enrichment mutates `trade_decisions`, and delete routes exist; preserve raw truth and write versioned derived snapshots.
- Data-quality state per derived field (`pit`, `latest_vintage_reconstruction`, `missing`, `ambiguous`).
- Confidence intervals/effective N and a machine-readable claim contract for Mentor.
- Separation between coaching insights and agent alpha/weights.
- Privacy/redaction of account data in LLM prompts and embeddings.

---

## 5. Revised recommendation

### Momentum: reject A and B as currently framed

Use a corrected hybrid:

1. **Registry/Edge lab is the research quarantine**, not the production injection mechanism.
2. Treat correlated candidates as two pre-registered families:
   - price trend: 12–1 or 6–1 momentum, benchmark/sector RS, 52w-high; volume/liquidity/volatility as gates/interactions;
   - fundamental/event momentum: reported surprise/revision/revenue corroboration only when PIT data is trustworthy.
3. Build one deterministic versioned momentum setup expert using the smallest subset with incremental OOS value.
4. Run it as an archetype shadow row beside v1; do not alter v1 technical/fundamental totals.
5. Promote through the same `measure_only → shadow_paper → paper_active → live_review_eligible → live_approved` lifecycle.

This preserves interpretability. It also prevents a technical champion weight from simultaneously controlling legacy RSI/EMA mean-reversion behavior and an unrelated newly injected momentum composite.

### Honest interim plan with tens of trades

- Freeze production v1 formula.
- Use broad PIT opportunity labels for factor research.
- Use fixed literature/economic priors plus shrinkage, not learned trade weights.
- Shadow the new setup and collect candidate-level outcomes, including abstentions.
- Treat paper trades as execution/economic confirmation, not the training population.
- Do not allow Learner to infer momentum weight from personal history or tens of fills.

### Behavior mirror phasing

#### M0 — repair transaction truth first

- immutable raw import rows;
- robust CSV parsing and transaction taxonomy;
- preserve original symbol and instrument lineage;
- normalize supported equity fills;
- reconstruct positions/lots/episodes;
- versioned data-quality report.

#### M1 — PIT technical and outcome truth

- trading-calendar horizons;
- consistent adjusted/unadjusted total-return basis;
- technical snapshot sliced strictly before/through the execution session as appropriate;
- benchmark/sector RS and MAE/MFE;
- versioned enrichment table, not destructive raw-row mutation.

#### M2 — deterministic descriptive behavior

- averaging-down rate, winner/loser holding, entry style, partial-profit behavior, drawdown exits, disposition-effect style metrics;
- episode-clustered intervals and sample-status labels;
- no LLM yet until claims are machine-verifiable.

#### M3 — Mentor narration

- narrate only structured claims with N, interval, baseline, and caveat;
- advisory/coaching only;
- no weight, feature, score, sizing, or order influence.

#### M4 — fundamental reconstruction, optional

- only after proving the provider offers accepted-at/as-known-then vintages;
- otherwise show `latest-vintage reconstruction` and prohibit causal/PIT language.

### Do not build

- raw quarterly revenue/EPS second derivatives as production factors;
- historical analyst revisions reconstructed from current consensus;
- a sixth freely learned momentum weight from tens of trades;
- automatic injection of any `feature_registry.status='active'` formula into live scoring;
- Mentor personality/mental-state diagnoses;
- behavior-derived alpha or autonomous strategy changes;
- then-vs-now comparisons as evidence that a historical trade was good/bad;
- any production scoring change justified by NVDA/Micron/SanDisk/Intel anecdotes.

---

## 6. Final build priority

1. Run the fade falsification/replay and repair any missing PIT feature logging needed for it.
2. Build M0 transaction-truth/episode reconstruction before adding mirror indicators.
3. Add only price-derived momentum-family fields in measure-only/PIT form.
4. Correct EdgeIC universe and multiple-testing/horizon-selection weaknesses.
5. Shadow one compact momentum setup expert.
6. Build M1/M2 behavior metrics with uncertainty.
7. Add Mentor narration.
8. Consider PIT fundamental/event momentum only after a source-quality proof.

The momentum proposal can become valuable, but only as a separate governed setup backed by broad opportunity evidence. The mirror can become a good coaching tool, but it should never be mistaken for a clean alpha dataset.

## Evidence references

- [Gu, Kelly & Xiu, *Empirical Asset Pricing via Machine Learning*](https://academic.oup.com/rfs/article/33/5/2223/5758276): price trends, liquidity, and volatility are repeatedly important, but broad data and genuine out-of-sample testing matter.
- [Harvey, Liu & Zhu, *…and the Cross-Section of Expected Returns*](https://www.nber.org/system/files/working_papers/w20592/w20592.pdf): multiple testing materially raises the hurdle for claimed factors.
- [Bailey et al., *The Probability of Backtest Overfitting*](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253): ordinary holdouts are not enough after trying many strategy variants.
- [DellaVigna & Pollet, investor inattention and earnings drift](https://www.nber.org/papers/w11683): PEAD is an economically motivated prior, not permission to use untimestamped or current-vintage earnings data.
- [SEC EDGAR API documentation](https://www.sec.gov/edgar/sec-api-documentation): filing/submission metadata is the appropriate starting point for accepted-at availability and source provenance.
