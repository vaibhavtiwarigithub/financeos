# Kairos — Full Architecture Review Request for Codex / External LLM

You are a senior quantitative systems architect and trading platform expert with deep
knowledge of: institutional algo trading systems, retail agentic trading platforms
(Composer, Danelfin, Alpaca, QuantConnect, Numerai, Lean, Vestinda, Streak, Smallcase),
modern AI agent frameworks (AutoGen, LangGraph, CrewAI, Phidata), and production-grade
ML pipelines. You have no prior knowledge of this codebase — everything below is provided
to you verbatim.

**Your job:** give a brutally honest, scored architecture review. No flattery. Treat this
like a Series A technical due diligence: identify what's solid, what's a liability, what's
missing, and what would need to change before this could be trusted at 10× the current
capital or user count.

If any assumption in this prompt appears technically wrong, internally inconsistent, or
dangerously underspecified, call that out explicitly instead of accepting it. Distinguish:
confirmed architectural fact, stated assumption, and your inference.

---

## What Kairos is

Kairos is a production web app (Next.js 15 App Router, TypeScript, Supabase/Postgres,
Vercel) that acts as an automated research + paper-trading loop for a retail investor
managing ~$10k NAV across US (Robinhood) and India (Zerodha Kite) markets.

**Core loop:**
```
Market data (US + India)
  → ResearchAgent (daily, scores stocks 0–100 across 5 dimensions)
  → agent_signals table
  → PaperTrader (fills pretend-money positions)
  → PositionMonitor (daily exits: trailing stop / score drop / target)
  → closed paper_trades
  → LearnerAgent (weekly, proposes Challenger strategy)
  → ValidationEngine (walk-forward replay on held-out decision ledger)
  → human promotes Challenger to Champion
  → Champion weights feed back into ResearchAgent
```

There is NO fully automated live trading. All real-money orders require a human click.
Live order path: agent proposes → human approves → Robinhood MCP or Kite API → fill.

---

## The 5 scoring dimensions (ResearchAgent)

Each stock is scored 0–100 per dimension, blended by Champion weights into `analyst_score`:

| Dimension | Data sources | What it measures |
|---|---|---|
| Fundamental | FinancialDatasets.ai, FMP / provider fallbacks where available | P/E, FCF yield, revenue growth, EPS revision |
| Technical | Massive/EODHD/TwelveData/Alpha Vantage fallback candles, computed locally | RSI, 50-day MA, momentum, volume |
| Sentiment | Alpha Vantage news sentiment / social sentiment where available | News tone, article volume |
| Macro | MacroSentinel (weekly FRED data) | Risk regime: CPI, unemployment, rates, GDP |
| Insider | FinancialDatasets.ai | Net insider buying/selling |

Missing data is **not supposed to be treated as neutral evidence**. Production scoring
tracks which dimensions are actually included, renormalizes weights across usable
dimensions when enough evidence exists, and treats fewer than 2 usable dimensions as
thin/abstain-worthy. `data_confidence` is tracked per signal so the system can identify
low-evidence decisions.

---

## Risk profiles (the ONLY investor-type differentiation currently implemented)

```typescript
export const RISK_PROFILES = {
  conservative: {
    score_threshold: 72,    // min analyst_score to open position
    position_size_pct: 7,   // max % of pool per position
    stop_loss_pct: 5,
    target_pct: 12,
    max_positions_per_sector: 2,
    ks_daily_loss_pct: -4,  // kill switch: daily loss %
    ks_drawdown_pct: 15,
    exit_hysteresis: 10,    // score must drop N points below threshold before exit
  },
  balanced: {
    score_threshold: 60, position_size_pct: 10, stop_loss_pct: 7,
    target_pct: 20, max_positions_per_sector: 3, ks_daily_loss_pct: -5,
    ks_drawdown_pct: 20, exit_hysteresis: 15,
  },
  aggressive: {
    score_threshold: 52, position_size_pct: 15, stop_loss_pct: 10,
    target_pct: 35, max_positions_per_sector: 4, ks_daily_loss_pct: -7,
    ks_drawdown_pct: 25, exit_hysteresis: 20,
  },
};
```

**There is no concept of day trader vs swing trader vs long-term investor.** The system
assumes a daily research cadence and holds positions until trailing stop (93% of high),
score drop, or price target. No time-horizon dimension exists. A day trader and a 10-year
investor use identical pipelines with only the 3 risk-profile dials above as differentiation.

---

## Screener architecture (dual-bucket, no explicit regime detection)

The screener runs two buckets simultaneously (architecture decision locked in CLAUDE.md):
- **Momentum bucket:** RSI > 60, price > 50-day MA, revenue acceleration, positive EPS revision
- **Value bucket:** P/E < sector median, high FCF yield, insider buying, analyst upgrades

The top-N candidates by analyst_score are merged (no explicit bull/bear regime switch —
the scoring naturally adapts). Max 3 screener candidates/day, max 10 new-buy candidates
total per run. Holdings are scored separately (uncapped) for SELL signals.

---

## Learning loop details

- LearnerAgent proposes "Challenger" — tweaked scoring weights + genome
  (entry threshold, exit stop/target percentiles, position sizing cap/floor)
- ValidationEngine: deterministic, no LLM, walk-forward replay on held-out
  `decision_observations` ledger (purged folds, no future peeking)
- Requires 10+ closed trades before LearnerAgent allowed to propose
- Human must promote Challenger to Champion (HTTP 412 if validation not passed)
- Champion = one per market (US / India), stored in Supabase `strategy_config`

**What the genome can mutate:**
- 5 dimension weights (fundamental/technical/sentiment/macro/insider)
- entry_threshold, exit_stop_pct, exit_target_pct
- position sizing mode (equal / kelly / score-proportional)
- holding horizon (days hint — advisory only, not enforced as a hard exit)

**What the genome CANNOT change:**
- Universe (locked to watchlist + screener output)
- Kill switch thresholds (owner-set, not mutable by agent)
- Live trading authorization (always human-gated)

---

## Edge/Factor discovery (P0/P1 built, measure-only)

A separate edge library (`lib/edges/`) computes 8 price/volume factors
(12-1 momentum, relative strength vs benchmark, 50/200 DMA trend+slope,
vol-adjusted momentum, ST reversal-in-uptrend, 52-week high proximity,
volume breakout, low realized volatility) across a curated ~120-stock liquid universe.
It also records `edge_universe_members`, `edge_signals`, `edge_signal_inputs`, and
`edge_ic_history`.

IC gate: edges must hit IC ≥ 0.02 AND |t-stat| ≥ 2 (Newey-West corrected for
overlapping windows) before being marked `shadow_eligible`.

Important current result: a narrow 30-name tech-heavy test initially showed several
apparently positive ICs, but broadening to ~120 diversified current-liquid names over
~2.5–3 years collapsed every edge's IC to ~0 or statistically insignificant. Nothing
cleared `shadow_eligible`. This is a positive process signal: the IC gate refused to
promote an apparent overfit/concentration artifact.

**Currently: measure-only. Edges do NOT affect analyst_score or fills.**

Known caveat: the broad universe is still current-liquid and survivorship-biased, not
true point-in-time index membership. The next data-rigor upgrade would be point-in-time
universe membership plus a longer multi-regime history before P2 shadow composite.

---

## Infrastructure / ops

- **Crons:** Supabase pg_cron fires → Vercel serverless (150s maxDuration)
- **LLM routing:** `TASK_MODELS` config per task type (screen/research/trade/etc.)
  Currently: screen=deepseek-v4-flash, research=claude-sonnet-4-6 (if key present)
- **Parallel research:** 5 symbols concurrently per run (as of 2026-07-09)
- **Data budget:** Alpha Vantage free tier (5 req/min); av-cache in Supabase absorbs repeat calls
- **Multi-LLM:** vault-backed provider keys (Anthropic/DeepSeek/Groq), swappable from UI
- **Kill switches:** daily loss / drawdown / accuracy — auto-pause live trading if breached
- **Multi-market:** US ($) and India (₹) pools never mix; separate champions, separate crons
- **Total paper trades to date:** ~6 US, ~8 India (system is very new)

---

## Comparison baseline (from ARCHITECTURE.md)

| Dimension | FinRobot (academic) | Kairos |
|---|---|---|
| Language | Python + AutoGen | TypeScript + Next.js |
| Deployment | Research notebook | Production web app |
| LLM coupling | Tightly coupled to OpenAI | LLM-agnostic (swappable) |
| Data | Golden dataset | Real paper trades |
| Safety | Limited | Kill switches, human gates, account isolation |
| Learning | Per-run feedback | Weekly batch (min 10 trades) |
| Real money | No | Human-gated Robinhood + Kite |

---

## What I need from you

### 1. Investor-type differentiation — gap analysis
The system has 3 risk profiles (conservative / balanced / aggressive) but NO concept of:
- Investment time horizon (day trader vs swing trader vs 1-year investor vs 10-year investor)
- Turnover preference (low-churn accumulator vs active rotator)
- Tax sensitivity (wash-sale awareness, short-term vs long-term gain optimization)
- Income vs growth orientation (dividend vs capital appreciation)
- Rebalancing style (threshold-based vs calendar-based)

**Question:** How material is this gap? What would a tier-aware architecture look like?
What specifically should be added (data model, agent behavior changes, UI) and in what
priority order? Give concrete schema and logic proposals, not vague suggestions.

### 2. Architecture score (0–10 per dimension, with reasoning)

Score each dimension:
- **Signal generation quality:** is the 5-dimension LLM-assisted scoring pipeline
  meaningfully better than a simple rules-based screener?
- **Learning loop rigor:** walk-forward validation + human gate — is this sound, or are
  there methodological holes (look-ahead leakage, overfitting, insufficient sample size)?
- **Execution realism:** does the paper trading model (same-tick fill, 0.05% slippage,
  trailing stop at 93% of high) reflect reality well enough to trust signals?
- **Risk architecture:** kill switches + per-sector cap + Kelly sizing + dual-pool
  separation — institutional quality or retail-grade?
- **Operational robustness:** idempotency guards, claim ownership, zombie reaping,
  watchdog, parallel crons — is this production-grade?
- **Data pipeline:** AV free tier + FinancialDatasets + FMP + FRED — is this sufficient
  for the signal quality claimed? What are the point-in-time survivorship bias risks?
- **Agent coordination:** single-agent-per-task design vs multi-agent debate — is this
  the right choice for the problem?
- **Security / money safety:** human-gate, account isolation, kill switches, approval_required
  mode — is this adequate for real money?

### 3. Benchmark comparison

Compare Kairos against the following trading agentic platforms:
- **QuantConnect / Lean** (institutional algo, fully backtested)
- **Composer** (retail no-code algo, strategy blocks)
- **Alpaca + custom agent** (API-first, no UI, developer-built)
- **Danelfin** (AI-scored stock picks, no execution)
- **Numerai** (crowd-sourced ML signal, tournament-based)
- **Streak / Smallcase** (India-focused, rule-based)
- **AutoGen/LangGraph + brokerage** (DIY agentic, research-grade)

For each: where does Kairos beat it, where does it lose, and is the gap closeable?

### 4. Critical weaknesses (honest, ranked by severity)

List the top 8–10 weaknesses you see in the architecture as described. For each:
- **Severity:** Critical / High / Medium / Low
- **Description:** what the problem is
- **Failure mode:** what breaks and how (concrete scenario)
- **Fix:** specific, implementable solution (schema, algorithm, code-level if helpful)

Flag especially:
- Any place where the "learning loop" is likely to overfit or fail to generalize
- Any place where paper performance would diverge significantly from live performance
- Any architectural assumption that breaks at 10× scale (users, capital, symbols)
- Any place where the LLM is doing work that a deterministic rule would do better

### 5. What's actually good (don't skip this)

Identify 3–5 architectural decisions that are genuinely well-designed or better than
typical retail quant systems. Be specific about WHY.

### 6. The single highest-leverage improvement

If you could add ONE thing to Kairos that would most improve its alpha generation or
risk-adjusted returns, what would it be? Give a concrete proposal (not a category).

### 7. Better architecture challenge

If the current architecture is not the right path, propose the better architecture.
Be specific: which subsystem should be replaced, which should be preserved, and what
the first migration/refactor should be. In particular, assess whether the current
EdgeScout P0/P1 result means:
- the factor path is working as a guardrail and needs better data/history;
- the selected price/volume factors are too weak;
- the universe methodology is invalid;
- or the platform should focus more on execution/risk/personalization than alpha discovery.

---

## Output format

Please structure your response as:

```
## 1. Investor-type gap analysis
[your analysis]

## 2. Architecture scores
| Dimension | Score /10 | Reasoning |
...

## 3. Platform benchmark
[per-platform comparison]

## 4. Critical weaknesses (ranked)
### W1 [Critical]: [title]
...

## 5. What's genuinely good
...

## 6. Highest-leverage improvement
...

## 7. Better architecture challenge
...

## Overall architecture score: X/10
[2-paragraph summary verdict]
```

Be direct. Score low where warranted. "Needs work" without specifics is useless.
If something in the architecture description above is ambiguous, state the assumption
you made rather than asking for clarification.
