# Edge/Factor Discovery + Signal Validation + Regime Filter

**Status: DRAFT PROPOSAL for external LLM review. No code written.**
Author: Claude (Kairos). Date: 2026-07-08. Reviewed/updated by ChatGPT (Codex), 2026-07-08 — source-backed methodology review through 2026.
Intended reviewers: other LLMs / quant-literate readers. This doc is written to be
self-contained enough to critique without the codebase in hand.

---

## 0. TL;DR

Kairos today generates trade ideas by having an LLM read ~15 news headlines and
invent "themes," then scores candidates on 5 soft dimensions and paper-fills the
top ones. That makes the **LLM the alpha source** — a black-box, news-chasing,
overfit-prone origin that the systematic-trading literature explicitly warns
against.

This proposal moves Kairos to the **standard institutional shape**:

1. **Discovery = a catalog of explicit, academically-grounded EDGES** (factor,
   technical, calendar, structural, information), each a deterministic formula —
   not an LLM guess.
2. **Every signal must earn its way in** via an **Information Coefficient (IC)
   stability gate** (rolling IC, IR, t-stat, decay) before it is allowed to size
   normal paper capital or become live-eligible. Tiny, capped exploratory paper
   may be allowed for candidate edges so the system can learn without pretending
   the edge is proven.
3. **A ranked Regime Filter** starts as a continuous size scaler, scored on
   protection / cost / stability / **cross-market reach**, replacing today's
   implicit, score-only regime handling. A hard on/off switch is a later,
   evidence-gated owner decision.
4. **The LLM is demoted** from alpha source to **research synthesizer**:
   hypothesis generation from literature, explanation, code/report drafting,
   orchestration. It never originates the number that sizes a position.
5. **Validation stays fees-first + walk-forward OOS + Monte Carlo** (extends the
   existing Validation Engine), so nothing trades live without surviving that.

The existing evolution machinery (genome, champion/challenger, shadow decisions,
learner, calibration, Build 4a slip) is **reused, not replaced** — this proposal
gives it a better *input* (validated factor signals) and a better *gate* (IC +
regime), rather than rebuilding the loop.

---

## 0A. ChatGPT reviewer correction — methodology update

The direction is correct, but the first draft over-restricts exploration and
overstates regime gating. The safer target architecture, based on current
factor-research practice through 2026, is:

1. **ThemeScout remains attention discovery only.** It may add candidates to the
   watchlist, but it never creates tradeable alpha or trade permission.
2. **EdgeScout / FactorScout becomes the deterministic alpha factory.** It
   computes formula-based edge values and validates them statistically.
3. **Candidate edges may enter shadow/exploratory paper with tiny caps before full
   IC proof.** Otherwise the system cannot explore. Normal paper sizing and any
   live eligibility still require validation.
4. **Regime starts as a continuous size scaler, not a hard on/off switch.** A hard
   block can be added later only after measured evidence and owner approval.
5. **Point-in-time data becomes a first-class gate.** No factor result is trusted
   unless every input has `source`, `as_of_date`, `available_at`, revision policy,
   and corporate-action adjustment policy.
6. **Long-only validation is required.** Kairos does not run long/short books; IC
   is useful, but the decisive test is whether the top-ranked long-only bucket
   beats cash/benchmark after realistic costs.
7. **Newly discovered factors face stricter multiple-testing gates than
   academically-priored factors.** A t-stat around 2 can be enough for known
   priors to enter shadow/paper; newly discovered/data-mined edges need a higher
   hurdle such as t-stat > 3 or FDR/q-value control before active/live eligibility.

---

## 1. Motivation — what the literature says vs. what we do

Sources the owner supplied (SetupAlpha Medium series: "Scientific Workflow for
Generating Alpha 2026", "60+ Market Edges 2026", "20 Trend-Based Regime Filters";
plus Investopedia on combining technical+fundamental), cross-checked against
standard references (Grinold & Kahn *Active Portfolio Management* — the IC/IR
framework; Asness/AQR on backtest overfitting; López de Prado *Advances in
Financial ML* — combinatorial purged CV, deflated Sharpe).

| Principle | Kairos today | Gap |
|---|---|---|
| Ideas come from **academic factors / documented edges** (SSRN, arXiv), not vibes | LLM invents "themes" from 15 headlines | No factor basis; news-chasing |
| **Test the signal first** — rolling IC/IR stability, t-stat, judged at the *median* parameter (not the best) | Whole *strategies* are walk-forward-validated, but individual signals are not IC-tested | No per-signal stability gate |
| **Regime filter** as explicit master switch, ranked on protection/cost/stability/**reach** (works SPY+QQQ+BTC, not one chart) | Implicit, score-threshold only; kill-switches are *risk* not *regime* | No ranked regime filter |
| **Fees-first, worst-case** friction | Build 4a slip tracking + notional caps | Partial — decent |
| **Stack multiple edge categories** | Single LLM-score edge | One edge, not stacked |
| **Understand WHY (causal); never trade a black-box signal** | LLM *is* the signal (black box) | Inverts the principle |
| **Judge by out-of-sample, not in-sample; expect overfit if you test many signals** | Shadow decisions + validation exist | IC/deflated-Sharpe discipline not enforced at signal level |

The central inversion: **the LLM should explain and orchestrate, not originate
alpha.** Alpha comes from validated, causal edges.

---

## 2. Design goals & non-goals

**Goals**
- Replace LLM-as-alpha with a deterministic **edge library** whose signals are
  reproducible and inspectable.
- Add an **IC-stability gate** so only signals with a real, stable, positive edge
  (after decay + fees) can influence normal sizing or live eligibility.
- Add a **ranked regime filter** as an explicit, market-portable size scaler first;
  hard blocking requires later evidence and owner sign-off.
- Keep the LLM for what it is good at: literature → hypotheses, and results →
  plain-language explanation.
- Reuse the existing validation/evolution/calibration machinery.
- Preserve every money-safety invariant (Section 9).

**Non-goals**
- Not proposing HFT / intraday microstructure (data + latency out of scope).
- Not removing the LLM (it moves roles).
- Not a from-scratch backtester — extend the current Validation Engine.
- Not auto-promoting anything to live — owner click + gates remain.

---

## 3. Architecture overview

```
        ┌─────────────────────────────────────────────────────────────┐
        │  EDGE LIBRARY (deterministic formulas, versioned)            │
        │  factor · technical · calendar · structural · information    │
        └───────────────┬─────────────────────────────────────────────┘
                        │ compute per (symbol, date)
                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  SIGNAL STORE  edge_signals(symbol,date,edge_id,value,z)     │
        └───────────────┬─────────────────────────────────────────────┘
                        │ rolling evaluation
                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  IC/IR VALIDATION GATE                                       │
        │  rolling IC, IR, t-stat, half-life/decay, turnover, net-of-  │
        │  fee. Promotes edge → {candidate|active|benched|retired}     │
        └───────────────┬─────────────────────────────────────────────┘
                        │ active edges only
                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  ENSEMBLE / COMPOSITE SCORE  (IC-weighted blend of active    │
        │  edges) → feeds the EXISTING champion genome weights/sizing  │
        └───────────────┬─────────────────────────────────────────────┘
                        │ gated by
                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  REGIME FILTER (ranked, per market) → master on/off + scale  │
        └───────────────┬─────────────────────────────────────────────┘
                        ▼
        existing pipeline: research signals → paper-trade (freshness/claim) →
        PositionMonitor → Learner → Validation Engine (WFO, MC) → promote

   LLM (DeepSeek/Claude via agent_config) sits BESIDE this: proposes new edges
   from literature (goes into the library as `candidate`, never auto-active),
   and writes the human explanation of each decision. Never a signal value.
```

---

## 4. The Edge Library

A versioned catalog. Each edge is a pure function `f(symbol, date, history) →
number` plus metadata. Categories mirror the "60 edges" taxonomy:

- **Factor** (cross-sectional, academically documented): 12-1 momentum, value
  (E/P, FCF yield, B/P), quality (ROIC, gross-profitability, accruals),
  low-volatility, size, short-term reversal, earnings-revision/PEAD,
  investment/asset-growth.
- **Technical / trend**: distance to SMA/EMA/KAMA/WMA, breakout (n-day high),
  RSI, MACD state, ATR-normalized momentum.
- **Calendar / time**: turn-of-month, day-of-week, holiday drift, seasonality,
  FOMC drift — used as *conditioners*, not standalone.
- **Structural**: index-inclusion drift, ETF-flow pressure, sector rotation,
  post-earnings-announcement-drift window.
- **Information** (later phase; needs alt-data): insider-cluster buys, 13F flow,
  news-sentiment surprise vs. estimate. (This is where the *current* LLM/news
  work is repurposed — as an *information edge input*, not the whole engine.)

**Metadata per edge** (drives the catalog table):
`edge_id, name, category, formula_spec (whitelisted grammar — reuse the existing
Feature Registry grammar), inputs[], rationale (WHY it should predict returns),
expected_sign, horizon_days, data_source, references[], status`.

Reuse: the **Feature Registry** (migration ~065-era, whitelisted-grammar-only)
already exists for exactly this "safe formula" purpose — extend it, don't reinvent.

---

## 5. Signal computation + store

Batch job (new cron or fold into research/cron) computes each `active`/`candidate`
edge for the tradable universe daily, cross-sectionally **z-scores** it (so edges
are comparable), and writes:

`edge_signals(symbol, date, edge_id, raw_value, z_value, universe_id)`.

Cross-sectional standardization + winsorization is the standard pre-IC step.
Neutralization (sector/beta) optional per edge (flag in metadata).

---

## 6. The IC/IR validation gate (the heart of it)

For each edge, on a rolling window, compute against forward returns
`r_{t→t+h}` at the edge's horizon `h`:

- **IC_t = Spearman rank-corr( z_value_t , forward_return_{t→t+h} )** per period.
  (Rank IC is robust to outliers vs. Pearson.)
- **Mean IC**, **IC volatility**, **IR = mean(IC)/std(IC)** (Grinold's
  fundamental law: IR ≈ IC · √breadth).
- **t-stat** of IC series vs. 0; require significance.
- **Decay / half-life**: IC by horizon (1,5,10,20d) — is the edge fresh or stale?
- **Turnover** implied by the signal → fee drag (fees-first: net-of-cost IC).
- **Stability**: rolling IC must not flip sign / collapse (judge the *plateau*,
  not the peak — the article's core point about not cherry-picking the best
  parameter).

**Promotion state machine** (per edge, per market):
`candidate → measure_only → shadow → exploratory_paper → active_paper →
live_eligible → live_approved`.

- `candidate → measure_only`: deterministic formula compiles, inputs exist, and
  the economic rationale is explicit.
- `measure_only → shadow`: point-in-time input availability is proven and the
  signal has enough historical observations to compute rank-IC.
- `shadow → exploratory_paper`: small positive gross IC, positive direction in
  multiple windows, and no major data-quality defects. Allocation is tiny and
  capped; this is exploration, not proof.
- `exploratory_paper → active_paper`: mean rank-IC ≥ τ_ic (e.g. 0.02–0.03 for
  daily equity factors), IR ≥ τ_ir, positive **net-of-fee** IC, stability over K
  windows, turnover/liquidity acceptable, and correlation to existing active
  edges < 0.8.
- `active_paper → live_eligible`: WFO/OOS + Monte Carlo pass, benchmark-relative
  long-only top-bucket alpha positive after costs, and decay monitor clean.
- `live_eligible → live_approved`: owner approval only.

Statistical hurdle:
- Academically-priored/known factors may enter shadow or exploratory paper with
  t-stat ≈ 2 when other gates pass.
- Newly discovered/data-mined factors need a stricter multiple-testing hurdle
  before active/live eligibility: t-stat > 3 or explicit FDR/q-value control.
- Overlapping forward returns require autocorrelation-aware standard errors
  (e.g. Newey-West) rather than naïve IID t-stats.

`active_paper → benched` when rolling IC/alpha decays below a floor for M
windows. `benched → retired` after prolonged failure. All transitions are logged
and owner-visible.

This gate is what stops "test 100 signals, one looks amazing by luck" (the
overfitting failure mode). Complement with **deflated Sharpe / multiple-testing
correction** (López de Prado) on the number of edges trialed.

---

## 7. Ensemble → existing genome

`active` edges are blended into a **composite cross-sectional score** per symbol,
weighted by each edge's recent IC/IR (shrunk toward equal-weight to avoid
over-fitting the weights — this is where the **existing Learner + genome weights**
plug in: the genome already carries per-dimension weights and the learner already
mutates them evidence-bound). The composite replaces today's "5 soft LLM
dimensions" as the score that drives entry threshold + Kelly sizing (which already
read the champion genome — see genome-live.ts).

Net effect: minimal change downstream. `research_agent` emits the composite score
into `agent_signals`; everything after (paper-trade freshness/claim, monitor,
learner, validation) is untouched.

---

## 8. Regime filter (ranked, portable, master switch)

A dedicated module, evaluated per market, that outputs `{state: risk_on |
risk_off | neutral, scale ∈ [0,1]}`. `risk_off` blocks new long entries (exits
always allowed — mirrors the existing sell-if-held rule); `scale` can taper size.

Candidate filters (implement several, rank them, pick per the article's rubric):
SMA(100–300) above/below, EMA, KAMA (adaptive — caught COVID in the study), WMA,
Hull, TEMA, n-day-high freshness, higher-lows, trend-quality (R² of price vs.
time), price-within-x%-of-high. **Rank each on:**
1. **Deal** — MAR / return-vs-drawdown improvement over buy-and-hold.
2. **Crash coverage** — % of each bear (dot-com, 2008, COVID, 2022) avoided.
3. **Cost** — annual return given up (the insurance premium).
4. **Reach** — must work on SPY **and** QQQ **and** (crypto/India proxy), scored
   at the **median** parameter across its whole range, not the best.

Chosen filter (+ runner-ups as an ensemble vote) becomes the master gate. Stored
in `regime_filters` (definition + rolling scorecard) and `regime_state`
(current per market). This supersedes the implicit score-only regime and the
`macro_regime` table's advisory-only role (macro stays as a *slow* overlay).

**Push-back note (CLAUDE.md):** the repo's locked decision says *no explicit
bull/bear switching* — "scoring should adapt." This proposal **re-opens that
decision deliberately**, because the regime-filter literature is strong and the
current implicit approach has no measured protection/cost. Flag for owner: this
is a conscious contradiction of an existing locked rule and needs explicit
sign-off. (An alternative that honors the old rule: keep regime as a *sizing
scaler* only, never a hard on/off. Reviewers: weigh in.)

---

## 9. Money-safety invariants (unchanged, must hold)

- Additive migrations only; verify applied before schema-coupled code ships.
- No autonomous live trading; owner click + `requireOwner` on every live order.
- No LLM places/cancels live orders, mutates money limits, mutates the active
  live strategy, or approves its own promotion. Here the LLM is even *further*
  from execution (it only proposes catalog entries as `candidate`).
- Append-only ledgers (paper_trades, paper_order_events) — inserts only.
- US(USD)/India(INR) money limits stay currency-separated.
- Long-only new positions; SELL only if held.
- Nothing goes `active`/live without passing IC gate **and** the existing
  fail-closed Validation Engine (WFO OOS + Monte Carlo) **and** owner promotion.

---

## 10. Data model (new, additive)

- `edge_catalog(edge_id, name, category, formula_spec, inputs, rationale,
  expected_sign, horizon_days, data_source, references, status, created_at)`
- `edge_signals(symbol, date, edge_id, market, raw_value, z_value, universe_id)`
  (partitioned/indexed by date+market; this is the big table)
- `edge_signal_inputs(edge_signal_id, input_name, source, as_of_date,
  available_at, revised_at, adjustment_policy, raw_ref)` — mandatory audit trail
  for point-in-time validation. No edge may be promoted if its inputs cannot prove
  when the app could have known the value.
- `edge_ic_history(edge_id, market, window_end, ic, ic_ir, t_stat, horizon,
  net_of_fee_ic, turnover, status_after)`
- `regime_filters(filter_id, definition, params, scorecard jsonb, active bool)`
- `regime_state(market, date, state, scale, filter_id, detail)`

All read-heavy analytics; no changes to money tables.

---

## 11. Integration points (existing files, indicative)

- `lib/research-agent.ts` — replace 5-dim soft score with the composite
  edge score; keep LLM call only for the written thesis/explanation.
  (Path verified: it is `lib/research-agent.ts`, not `lib/agents/research-agent.ts`.)
- Feature Registry / whitelisted grammar — `lib/validation/feature-compiler.ts`
  (verified) hosts the safe-formula grammar; extend it for edge formulas.
- `lib/validation/engine.ts` (Validation Engine, verified) + `app/api/agents/backtest/*`
  — add IC gate + deflated-Sharpe; extend WFO to the edge composite.
- `lib/validation/genome-live.ts` + Learner — consume IC-weighted edge blend as
  the weights it tunes (evidence-bound mutation already exists).
- `app/api/agents/paper-trade/route.ts` — unchanged (freshness/claim/sizing all
  reused); it just fills better-founded signals, now also gated by `regime_state`.
- Macro Sentinel (`macro_regime`) — demoted to slow overlay beneath the fast
  regime filter.
- Dashboard — new read-only panels: edge catalog + IC scorecards, regime state.

---

## 12. Rollout phases (each independently shippable + measurable)

- **P0 — Edge library + signal store (measure-only).** Implement 6–10 factor +
  technical edges, compute daily, store `edge_signals`. No effect on trading.
- **P1 — IC gate + dashboard.** Compute rolling IC/IR/t-stat; classify edges;
  surface scorecards. Still measure-only. This alone tells us whether ANY current
  idea has real edge.
- **P2 — Composite score in SHADOW.** Blend active edges; run alongside the live
  LLM/current score via the **existing shadow_decisions** machinery (no fills).
  Compare current score vs. factor score vs. blended score on live,
  contemporaneous opportunities.
- **P3 — Exploratory paper.** Candidate/known-prior edges that clear data-quality
  and early IC checks may receive tiny capped paper allocation. This is explicit
  exploration, not proof, and is excluded from live eligibility until later gates
  pass.
- **P4 — Regime filter (measure + rank).** Implement filters, score them on
  history, and run as an advisory/continuous size scaler first. Hard blocking is
  a later owner decision after evidence.
- **P5 — Active paper.** Validated composite score + regime scaler drive the PAPER
  book. LLM is demoted to explanation. Watch calibration + Performance-Truth for
  several weeks.
- **P6 — Live (owner-gated, unchanged safety).** Only after WFO OOS + Monte Carlo
  + long-only benchmark-relative alpha + owner promotion, and only for edges that
  stayed `active_paper` through the soak.

Each phase reuses existing infra (shadow, validation, calibration, genome), so
risk is incremental and reversible.

---

## 13. Risks / failure modes to critique

- **Small-sample IC noise**: with a tiny paper history, IC estimates are unstable.
  Mitigation: compute IC on a broad historical universe (not just our filled
  trades) via the price-history backfill; treat live paper as confirmation only.
- **Multiple-testing / overfitting the catalog**: trialing many edges inflates
  false positives. Mitigation: deflated Sharpe, hold-out, cap the number of
  simultaneously-active edges, prefer academically-priored edges.
- **Regime filter = one more overfit dial**: the article shows band/adaptive
  filters wobble. Mitigation: judge at median parameter + require cross-market
  reach; prefer the simplest filter that clears the bar.
- **Data coverage for India**: factor inputs on NSE via Yahoo/Kite are thinner —
  IC gate may bench most edges there initially (acceptable; fail-closed).
- **Turnover/fees eat factor edges**: enforce net-of-fee IC from the start
  (fees-first).
- **Contradicts the locked "no explicit regime" decision** — see §8; needs owner
  sign-off.

---

## 14. Open questions for reviewers (LLMs / quants)

1. Is rank-IC + IR + t-stat + deflated-Sharpe a sufficient signal gate, or should
   we add combinatorial purged cross-validation (CPCV) from day one?
2. IC thresholds: what τ_ic / τ_ir are defensible for daily US equity factors on
   a ~1–3k name universe? (We proposed IC≥0.02–0.03, IR≥~0.3 — too lax/strict?)
3. Regime as **hard on/off** vs **continuous sizing scaler** — which is more
   robust given it will also gate India with thin data?
4. Ensemble weighting: IC-weighted vs. equal-weight vs. risk-parity across edges —
   which best resists weight overfitting at our scale?
5. Where exactly should the LLM stay useful — only literature→hypothesis and
   explanation, or also as a *conditioner* (e.g. news-surprise as one information
   edge feeding the IC gate like any other)?
6. Minimum history before an edge may go `active` (calendar time vs. number of
   independent IC observations)?
7. Anything structurally missing vs. how real agentic-quant platforms
   (e.g. QuantConnect + factor libraries, WorldQuant-style alpha pools) are built?

---

## 15. References
- Grinold & Kahn, *Active Portfolio Management* — IC/IR, fundamental law of
  active management (IR ≈ IC·√breadth).
- López de Prado, *Advances in Financial Machine Learning* — deflated Sharpe,
  purged/combinatorial CV, backtest overfitting.
- Asness / AQR — factor premia, implementation shortfall, overfitting warnings.
- Owner-supplied: SetupAlpha "Scientific Workflow 2026", "60+ Market Edges 2026",
  "20 Trend-Based Regime Filters" (Medium); Investopedia "Blend Technical and
  Fundamental Analysis".
- Existing Kairos infra this builds on: Feature Registry (whitelisted grammar),
  Validation Engine (WFO, fail-closed), shadow_decisions, strategy genome +
  Learner (evidence-bound), calibration, Build 4a slip tracking.
- Harvey, Liu & Zhu, "...and the Cross-Section of Expected Returns" — new/data-
  mined factors need higher multiple-testing hurdles; t-stat > 3 is a useful
  rule of thumb for newly discovered factors.
- Bailey & López de Prado, "The Deflated Sharpe Ratio" — selection bias and
  multiple testing inflate backtest Sharpe; use DSR/PSR-style correction.
- Benhenda, "Look-Ahead-Bench" (2026) — point-in-time LLM finance workflows must
  explicitly test for look-ahead bias and decay across temporally distinct market
  regimes.
- Azevedo, Hoegner & Velikov, "The Expected Returns on Machine-Learning
  Strategies" — ML/anomaly strategies can work after costs, but only with careful
  treatment of transaction costs, post-publication decay, and stale historical
  data.
- Baldi-Lanfranchi, "Transaction-cost-aware Factors" (2024) — factor construction
  should optimize the trade-off between exposure and rebalancing costs; especially
  relevant for high-turnover edges like momentum.
- Research Affiliates / Robeco / Man Group factor implementation notes —
  practical factor investing must account for turnover, liquidity, crowding,
  risk management, and investability, not just gross historical returns.

**No implementation until owner approves + reviewers vet. Theme Scout has been
reverted to a plain news-driven scout in the interim (it is not the alpha source).**

---

## Reviewer changelog (ChatGPT, 2026-07-08)

- Updated author line to record ChatGPT/Codex methodology review.
- Corrected the TL;DR: IC validation is required for normal sizing/live
  eligibility, but tiny capped exploratory paper is allowed so the system can
  learn.
- Corrected the regime design: start with continuous size scaling; hard on/off is
  deferred until evidence and owner approval.
- Added Section 0A with the intended separation: ThemeScout = attention
  discovery; EdgeScout/FactorScout = deterministic alpha factory.
- Replaced the simple `candidate → active` promotion with a full lifecycle:
  `candidate → measure_only → shadow → exploratory_paper → active_paper →
  live_eligible → live_approved`.
- Added stricter statistical gates for newly discovered/data-mined edges:
  t-stat > 3 or FDR/q-value control before active/live eligibility.
- Added autocorrelation-aware standard error requirement for overlapping forward
  returns.
- Added mandatory point-in-time input audit table `edge_signal_inputs`.
- Updated rollout to include exploratory paper and active paper as separate
  phases.
- Added recent/current references through 2026 covering look-ahead bias,
  transaction-cost-aware factors, ML strategy implementability, and multiple
  testing.
