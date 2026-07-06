# Feature: Research Journal (daily funnel report + learning evolution)

Status: BUILT (v1 shipped 2026-07-06, Decision 40) · Owner: Vaibhav · Started 2026-07-06

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
- Multi-market side-by-side view in v1 — one market at a time (matches the
  existing market-scoping convention across the app), India rides in a
  later pass once the US version is validated.

## Acceptance

- `pipeline_stage_events` inserts are additive and fail-soft (a logging
  failure must never block or alter the actual trading decision it's
  describing — same convention as `decision_journal` writes elsewhere).
- Daily Funnel renders correctly with zero events (first day after ship).
- Evolution tab is honest about thin history ("not enough learner runs yet
  to show a trend") rather than drawing a misleading chart from 1-2 points.
- tsc + build pass; migrations handed over as clickable links + full paths.
