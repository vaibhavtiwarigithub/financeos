# Feature: Research Journal (daily funnel report + learning evolution)

Status: BUILT (v1 shipped 2026-07-06; v2 novice-first upgrade approved 2026-07-12) · Owner: Vaibhav · Started 2026-07-06

## Motivation

Today, "why did the agent do/not do X" requires manually querying 4+ tables
(`decision_observations`, `trade_proposals`, `paper_trades`, `learner_runs`)
and cross-referencing by hand — no single place shows the full chain for a
symbol on a given day, and no single place shows whether the learning loop
is actually improving over weeks/months. `app/dashboard/agents/history`
exists but never reads `decision_observations` — it's unrelated to this.

The ask: a daily report showing, per symbol scored that day — which
screener bucket/criteria flagged it, its full score breakdown, why it
passed or failed at each pipeline stage (research threshold → portfolio
constructor → trade execution), and a separate longer-horizon view of how
the screener, LearnerAgent, and feature registry are evolving.

## What already exists (verified against live schema, 2026-07-06)

`decision_observations` (Phase 1 ledger) already logs, per symbol per research
run: `analyst_score`, `score_threshold`, `entry_eligible`, sub-scores
(fundamental/technical/sentiment/macro/insider), and a `features` jsonb blob
that already contains honest per-dimension notes (e.g. `"no macro data"`,
`"ETF — no company fundamentals"`). This is real, live data — verified via a
sample query (IAU/GDX/SLV, 2026-07-06: score 52 < threshold 60 → correctly
rejected, with the exact reason visible in `features`).

## Gaps (why this can't be built as a pure read-only aggregation today)

1. **No screener-stage tag.** `decision_observations.features` has no
   `bucket` (momentum|value) or `criteria_matched` field. ResearchAgent's
   dual-bucket scoring runs today but doesn't record which bucket/rule
   flagged a candidate.
2. **No per-symbol downstream trail.** Once a candidate clears the research
   threshold, Portfolio Constructor's shrink/reject decision and the
   trade-proposal/fill outcome exist in separate tables with no shared key
   back to the originating `decision_observations` row beyond `signal_id`
   (which exists on `decision_observations` but isn't written-to /
   consistently joined by the downstream stages today).
3. **No feature-registry status-history log.** `feature_registry` has a
   current `status` (proposed/quarantined/active/retired) but no history of
   *when* it changed — the Evolution tab needs a timeline, not a snapshot.

## Proposed architecture

### Principle: instrument at the source, don't reconstruct after the fact

Reconstructing "why" from final-state tables is lossy (a proposal that got
rejected by Portfolio Constructor before ever becoming a `trade_proposals`
row leaves no trace today). Instead, write one small journal row at each
stage transition, all keyed by `signal_id`, then join for display.

### Schema changes

**A. `decision_observations.features` — add two fields at write time**
(`lib/research-agent.ts`, no migration needed — same jsonb column):
```
features.screener = { bucket: "momentum" | "value", criteria_matched: string[] }
```
Populated from the existing dual-bucket scoring logic in
`lib/research-agent.ts` (the bucket assignment already happens in code —
this just records which one won and why, instead of discarding it).

**B. New table `pipeline_stage_events`** (append-only, mirrors
`decision_journal`'s generic shape but scoped to this funnel so queries stay
cheap and don't compete with the general journal):
```sql
create table pipeline_stage_events (
  id bigserial primary key,
  signal_id uuid not null,
  symbol text not null,
  market text not null default 'us',
  stage text not null, -- 'research' | 'portfolio_constructor' | 'proposal' | 'execution'
  outcome text not null, -- 'passed' | 'rejected' | 'shrunk' | 'filled' | 'expired'
  reason text, -- human-readable, e.g. "sector cap: 3/3 Tech positions already held"
  detail jsonb, -- stage-specific numbers (e.g. shrink %, correlation haircut applied)
  created_at timestamptz not null default now()
);
```
Written by: `lib/research-agent.ts` (stage='research'), the Portfolio
Constructor call inside `app/api/agents/paper-trade/route.ts`
(stage='portfolio_constructor'), the trade-proposal/approval flow
(stage='proposal'), and `execute_paper_fill`/broker-order paths
(stage='execution'). Each write is one extra `insert` at a point where the
decision is already being made — no new decision logic, just recording the
existing one.

**C. `feature_registry_history`** (small, append-only): `id, feature_id,
from_status, to_status, reason, created_at` — written wherever
`feature_registry.status` is currently updated (feature-check route,
learner's `propose_feature` tool).

### API

- `GET /api/agents/research-journal?date=YYYY-MM-DD&market=us` — for each
  symbol with a `decision_observations` row that day, join
  `pipeline_stage_events` (by `signal_id`) into an ordered stage list, plus
  the terminal state (rejected-at-research / rejected-at-constructor /
  proposed-pending / filled / expired).
- `GET /api/agents/research-journal/evolution?market=us&days=90` — time
  series: LearnerAgent weight deltas (`learner_runs`), feature-registry
  status transitions (`feature_registry_history`), calibration drift
  (`model_artifacts`), shadow-decision agreement rate (`shadow_decisions`
  vs realized champion decisions).

### UI — new page `/dashboard/research-journal`

Two tabs, matching the existing dark-theme card/pill conventions:

- **Daily Funnel** — date picker (default today), per-symbol expandable
  rows: score breakdown → screener bucket/criteria → stage-by-stage
  pass/reject with reason → terminal badge. Empty state: "No candidates
  scored yet — research runs at 9 AM ET" (mirrors existing empty-state
  language elsewhere in the app).
- **Evolution** — line/step charts: weight deltas over time per dimension,
  feature-registry promotion/retirement timeline, calibration Brier-score
  trend, shadow-decision agreement rate. Each metric card states plainly
  when there isn't enough history yet (no false precision on thin data —
  matches the Goal tracker's feasibility-sentence convention).

### Docs required in the same change (per CLAUDE.md)

- `public/agent-diagrams/system-map.json` — this doesn't add a new
  agent-to-agent data flow, but it DOES add new observability into existing
  flows (research → constructor → proposal → execution). Add a note to each
  touched node's description (RESEARCH, TRADER/PROMOTE area) rather than a
  new node, plus a `history` entry.
- `PROJECT_DECISIONS.md` — one entry once approved and built.
- `WORK_LOG.md` — session entry.

### Non-goals (v1)

- Real-time streaming of the funnel as it happens (this is a post-hoc daily
  report, not a live pipeline visualizer).
- Auto-alerting on funnel anomalies (e.g. "0 signals passed today") — that's
  already partially covered by the existing stale-run / 0-signal alert in
  `research/cron`; this feature is for understanding *why*, not re-alerting.
- Multi-market side-by-side view in v1 — one market at a time. India is now
  supported through the same market-scoped picker and local-calendar rules.

## Acceptance

- `pipeline_stage_events` inserts are additive and fail-soft (a logging
  failure must never block or alter the actual trading decision it's
  describing — same convention as `decision_journal` writes elsewhere).
- Daily Funnel renders correctly with zero events (first day after ship).
- Evolution tab is honest about thin history ("not enough learner runs yet
  to show a trend") rather than drawing a misleading chart from 1-2 points.
- tsc + build pass; migrations handed over as clickable links + full paths.

## V2 — novice-first evidence and context (approved 2026-07-12)

### Product question

The journal must answer, in order: **what is this security; why did it appear;
what changed; what does Kairos currently think; how reliable is that view; what
could invalidate it; and what happens next?** Exact scores and raw indicators
remain available, but are the audit layer rather than the headline.

### Three-layer information architecture

1. **Decision summary (default/collapsed):** asset identity/type, discovery state
   (`new`, `recurring`, `holding`, `re-entry` when recorded), action (`research`,
   `watch`, `wait`, `paper candidate`, `hold`, `exit review`, `avoid`), score,
   evidence coverage, decision confidence, why-now, strongest positive, largest
   risk, and next step.
2. **Evidence and context (expanded):** grounded thesis, technical translation,
   material catalysts/news context when stored, theme/peer context when supported,
   counter-evidence, invalidation conditions, history/score change, and source-safe
   links for independent verification.
3. **Quant audit (expanded):** dimension values, structural/applied weights,
   point contributions, availability/freshness, raw evidence, and pipeline events.

### Truth and safety invariants

- Keep **available-evidence score**, **structural evidence coverage**, and
  **decision confidence** separate. A 98 computed from two dimensions is not
  displayed as five-dimension/high-confidence evidence.
- Missing/inapplicable dimensions display `Not used`, never a neutral-looking
  numeric score. They contribute zero points and lower coverage only when the
  dimension is structurally applicable.
- The LLM may summarize already-recorded evidence. It cannot invent prices,
  financials, news, peers, confidence, action, targets, or invalidation levels.
- News/theme/social context does not authorize a trade. It may explain, confirm,
  reduce confidence, or veto through a separately validated deterministic rule.
- No per-card provider fan-out on initial page load. The immutable stored decision
  renders first. Optional current enrichment is on-demand, cached, bounded, and
  explicitly newer than the historical decision.
- Point-in-time history is never rewritten. V2-derived presentation fields are
  computed at read time or written additively for future observations.

### Asset-aware context

- **Company:** business/sector, growth, profitability, cash flow, leverage,
  valuation, estimates/earnings when available.
- **ETF/fund:** exposure, holdings/concentration, liquidity, expense/flows,
  geography/currency hedge and structural risks. Company fundamentals and insider
  activity are inapplicable.
- **India company:** NSE symbol normalization and NSE/BSE/company-announcement
  links; India-specific provider freshness.
- Asset type comes from recorded `agent_signals.asset_class` plus the canonical
  symbol classifier. Never infer ETF/company status from missing fundamentals.

### History and novelty

For all symbols in the selected daily run, one bounded history query computes
first-seen date, observation count, previous score/direction and change. Existing
holdings are always labeled `holding`; otherwise first observation is `new` and
later observations are `recurring`. `re-entry` requires a recorded re-entry event
and is never guessed from elapsed time.

### Technical translation

Translate deterministic evidence into novice language: trend, momentum, moving-
average posture, volume confirmation and extension/breakdown risk. RSI/MACD are
diagnostics, not independent votes; correlated indicators must not be double-
counted. Never call RSI near 50 "strong" or low volume "confirmation."

### External validation links

Build links deterministically from validated symbols: TradingView, Yahoo Finance,
SEC/company research for US, NSE/BSE for India, and issuer pages only when a
verified issuer URL exists. Links are labeled external and are never scraped as
application data or treated as scoring evidence.

### V2 phased delivery

- **V2.0 (this build):** decision/coverage/confidence separation, asset type,
  novelty/history, novice action/technical translation, missing-dimension honesty,
  score change, and deterministic TradingView/Yahoo/SEC/NSE/BSE links. Uses only
  stored data; no scoring or order-path change.
- **V2.1:** on-demand cached material-news panel with source, published/available
  timestamps, deduplication and official-vs-commentary classification.
- **V2.2:** point-in-time peer/theme comparison after comparable-group and provider
  coverage validation. Measure-only until incremental value is proven.

### V2 acceptance

- A novice can identify the security state, current action, confidence, strongest
  evidence, largest gap and next step without expanding raw score construction.
- ETF examples (including EUAD) never display company-fundamental/insider evidence
  as applicable; India links and symbols resolve correctly.
- A high score with 2/5 applicable dimensions visibly reports limited coverage and
  cannot be labeled high confidence.
- Historical and on-demand current context are visually/time separated.
- API reads are bounded; partial context failure does not hide the stored decision.
- TypeScript, unit tests, production build, and US/India browser checks pass.
