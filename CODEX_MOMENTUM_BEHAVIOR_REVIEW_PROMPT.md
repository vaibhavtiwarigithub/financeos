# Architecture Review Request — Momentum Factors + Trade-Behavior Mirror

You are a skeptical quant + systems architect reviewing two proposed features for a
personal autonomous trading system. **Your job is to CHALLENGE and BREAK wrong assumptions,
not to praise.** If something is wrong, say so bluntly and give a detailed, concrete fix.
Be adversarial. Assume the author is overconfident. Prioritize: statistical validity,
overfitting/survivorship, look-ahead leakage, data availability realism, and whether the
design actually achieves its stated goal.

At the end, return: (1) a ranked list of the most dangerous wrong assumptions, each with a
concrete fix; (2) anything missing; (3) a revised recommendation. Do not soften. If a whole
approach is misguided, say that and propose the right one.

---

## 0. System context (so you review against reality)

**Kairos** is a single-owner autonomous trading OS. Next.js 15 + Supabase + Vercel. Reasoning
LLM = DeepSeek (via a router); an execution kernel with hard money-safety gates does live/paper
trades on Robinhood (US) + Zerodha Kite (India). Two markets, each with its own champion strategy.

**Scoring pipeline (`deterministic_v1`):** a ResearchAgent scores each candidate on **5
deterministic dimensions** (no LLM numbers; the LLM only writes thesis/veto). Dimensions:
fundamental, technical, sentiment, macro, insider — each 0–100.

**Composite:** `analyst_score = Σ (dimension_score × weight[dimension])`. Missing/inapplicable
dimensions are EXCLUDED via an availability mask and remaining weights renormalized to sum to 1.0;
`<2` usable dimensions → abstain. Base weights default F.30/T.25/S.20/M.15/I.10, overridden by a
per-market **champion** `weights_snapshot`.

**Exact current sub-score formulas (the priors — hand-tuned, deterministic, fixed):**
- *Fundamental*: base 50; P/E scored RELATIVE to sector (`ratio = pe / SECTOR_PE_NORM[sector]`;
  <0.7 +18 … ≥2.0 −22); profit margin (>0.20 +20 … <0 −20); ROE (>0.20 +15 …); EPS sign (±5/−10);
  rev-growth YoY (>0.20 +15 …); analyst target upside (target vs live close / 200-DMA: >25% +12,
  >10% +6, <−10% −8). ETF → flat 55.
- *Technical*: base 50; RSI(14) as a CONTINUOUS interpolation over anchors
  `(20,−20)(35,−16)(45,−5)(50,+2)(55,+12)(60,+25)(72,+25)(75,+6)(85,−10)(100,−15)`;
  price vs EMA50 ±15; price vs EMA20 ±10; 20-day trend (±3% band) ±10;
  volume vs 20d-avg (direction-confirming) ±8/±4.
- *Sentiment*: StockTwits bull/(bull+bear); else AV news `(x+1)×50`; else label. Excluded unless has_data.
- *Macro*: `100 − danger_score` from a weekly regime table (one scalar for the whole market).
- *Insider*: `10 + buyRatio×80` over 90 days, requires ≥3 transactions else excluded.

**Learning:** a per-market LearnerAgent proposes weight-change CHALLENGERS → a fail-closed
walk-forward Validation Engine (moving-block bootstrap, purged/embargoed folds) → owner promotes to
champion. A GENOME can also evolve entry threshold / exit stops-targets / sizing / horizon (bounded).
A separate **EdgeScout/EdgeIC** "edge lab" measures rank Information-Coefficient (Newey-West t) of
candidate factors on a broad universe BEFORE anything trades — it already **rejected** naive
price/volume edges as noise (a 30-name signal that collapsed to ~0 IC on 120 names — concentration/
survivorship artifact). A **Feature Registry** exists to propose→IC-validate→promote new features
via a whitelisted expression grammar (never executes LLM-authored code). Decision ledger stores
point-in-time observations + matured forward-horizon (2/5/10/20d) benchmark-neutral labels.

**Sample size reality:** tens of closed trades per market so far (not thousands). This constrains
what can be learned without overfitting.

---

## 1. WHY we want these features (the motivation to pressure-test)

**(a) Momentum/growth factors.** The current scorer is value + mean-reversion tilted and appears to
STRUCTURALLY FADE the stocks that became multibaggers this cycle (Micron, SanDisk, NVDA, Intel-type
memory-cycle / AI re-rating moves): it penalizes RSI>75 (they run overbought for weeks) and high P/E
(the re-rating engine — earnings acceleration — isn't measured, only P/E level). It has no relative
strength, no earnings-estimate-revision momentum, no revenue/earnings acceleration, no 52w-high/
breakout. Owner wants to catch such movers earlier.

**(b) Trade-behavior mirror.** Owner wants to import all past Robinhood transactions, reconstruct the
fundamental + technical values AT THE TIME of each historical trade, compare to those stocks NOW, and
have a Mentor agent characterize the owner's behavioral/mental pattern (buy strength vs dips, sell
winners early, average down on losers, panic-sell drawdowns) grounded in the indicator values at each
entry/exit.

---

## 2. PROPOSAL A — Momentum / Growth Factors

Add as deterministic factors: relative strength (stock − benchmark return, 1/3/6mo, percentile);
earnings-estimate revision (Δ consensus EPS/target 30/90d); revenue acceleration (QoQ growth 2nd
derivative); earnings acceleration; 52w-high proximity (`price/52w_high`); volume breakout (up-day
volume z-score).

Two options: **A)** new 6th dimension `momentum_score` (extends weight vector, champion snapshot,
validation, genome). **B) (recommended)** each factor enters the Feature Registry, is IC-validated in
the edge lab, and on promotion contributes to the technical (RS/52wH/vol) or fundamental (revisions/
acceleration) dimension via the whitelisted compiler — no new weight slot.

Guardrails claimed: no factor influences live score until it clears the IC gate on the BROAD universe
(fail-closed); momentum is ADDED not replacing value; per-market champion weights decide when it
dominates; no look-ahead; no money-path change. A "momentum archetype" would later stop hard-fading
high RSI when RS + acceleration confirm (regime-routed).

**Challenge everything here.** Specifically pressure-test:
- Is "the scorer fades multibaggers" actually true, or a hindsight/survivorship story? How would you
  falsify it with the data we have?
- Are these 6 factors independent, or collinear (RS vs 52w-high vs volume-breakout may be one factor)?
- Estimate-revision data quality/latency/point-in-time integrity — is it usable without leakage?
- Revenue/earnings "acceleration" on quarterly data = tiny n, huge noise. Is a 2nd derivative on 4-8
  quarters statistically meaningful, or garbage?
- Does IC on a 2/5/10/20d horizon even capture a MONTHS-long multibagger thesis? Horizon mismatch?
- Option A vs B — is B (feature registry into existing dims) actually cleaner, or does forcing
  momentum into a "technical" dimension distort weight learning?
- Given tens of trades per market, can champion weights EVER learn a momentum tilt, or is this
  hopeless until 100s of trades — and if so what's the honest interim plan?

## 3. PROPOSAL B — Trade-Behavior Mirror

Already built: CSV import → `trade_decisions`; enrich adds macro regime at trade date + FORWARD price
1d/1w/1m/3m + outcome_score + win/loss tags; Mentor reads them.

Gap (to build): point-in-time technical (RSI/EMA/RS/52wH at exec_date, cheap — from the daily series
already fetched) AND fundamental (P/E from historical price × historical EPS via FinancialDatasets
historical statements) at each trade; then-vs-now compare; a deterministic behavioral-fingerprint pass
(entry-RSI distribution, winner-hold vs loser-hold duration, add-to-loser rate, drawdown-exit timing,
regime skew) that the Mentor NARRATES (never fabricates numbers) → mentor_insights.

Phasing: P0 technical PIT; P1 behavioral fingerprint + narration; P2 fundamental PIT.

**Challenge everything here.** Specifically:
- Point-in-time fundamentals: is reconstructing P/E from historical price × historical EPS actually
  correct (restatements, split adjustment, TTM vs quarterly EPS, reporting-lag / as-of-then vs
  as-known-then)? Where does leakage creep in?
- Robinhood CSV: are exec prices/dates reliable? Wash sales, options, fractional shares, dividends,
  splits, corporate actions, partial fills — what breaks the parser or the outcome math?
- Behavioral metrics: with a small personal trade count, are "patterns" real or noise? What sample
  size makes a claimed pattern (e.g. "you sell winners early") statistically honest vs a just-so story
  the Mentor will confidently hallucinate?
- Is the whole "mirror" useful for improving the AUTONOMOUS system, or is it purely a human-coaching
  artifact? Should any of it feed the agents, or stay strictly advisory? Argue it.

---

## 4. What to return

1. **Ranked wrong/dangerous assumptions** — each: the assumption, why it's wrong, a concrete fix.
2. **Statistical rigor audit** — leakage, survivorship, overfitting, horizon mismatch, sample size,
   multiple-testing across factors. Be specific.
3. **Missing pieces** in both designs.
4. **Revised recommendation** — Option A vs B for momentum; phasing for the mirror; what to build
   FIRST given tens-of-trades reality; and anything that should NOT be built.
5. If any premise (incl. "the scorer fades multibaggers") is unproven, give the exact test/query to
   prove or kill it before writing code.

Be direct and technical. Fixes must be concrete enough to implement, not generic advice.
