# Feature: Mentor AI Agent

Status: DRAFT → building v1 (2026-07-04).

## What's out there (and the gap)
- **Trade-journal analytics** (Edgewonk, TraderVue, Chartlog): compute stats on
  your behavior — win rate by setup, time-of-day, position-sizing errors,
  revenge trading. Descriptive, not coaching. You read charts and self-diagnose.
- **Trading-psychology coaches**: human, expensive, not data-grounded in YOUR fills.
- **Robo-advisors / SA "health scores"**: rate your portfolio, not your *behavior*.

**Nobody combines**: your actual decision data + live market regime + a personalized
AI coach that reasons about *you* + a learning curriculum with milestones. That's
the gap Kairos fills.

## What we should have — MentorAgent (true AI tool-use agent)
Not a scorer (the old /api/mentor/evaluate just graded a single thesis). A real
agent that, on demand (and feeding the briefing), pulls the user's behavior +
learning progress + market context + trading principles, reasons over them, and
returns personalized coaching.

### Pipeline
runAgentLoop on `deepseek-reasoner` (tool-calling works; no ANTHROPIC_API_KEY).
Tools:
- `query_behavior` — trade_decisions outcome_score patterns (what the user does
  well/badly across regimes), buy vs sell accuracy, recurring pattern_tags;
  closed paper_trades outcomes.
- `query_learning_progress` — closed-trade count, Phase 0/1 status, recent
  LearnerAgent hypotheses, rescore flags.
- `query_market_context` — current macro regime + index posture.
- `read_principles` — human-written learning_priors (Bayesian market principles).
- `finish` — structured coaching (below).

### Output (stored in `mentor_insights`)
- `grade` (0-100) + `confidence` (0-1) on the user's current trading discipline/progress.
- `strengths` [] — what they're doing right (grounded in their data).
- `focus_areas` [] — the 1-3 things to work on, each with why.
- `lesson` — ONE lesson tailored to the current market regime AND their gaps.
- `market_note` — how today's regime should shape their behavior.
- `next_milestone` — the concrete next step (e.g. "close 4 more trades to unlock
  weight-tuning; journal a thesis for each").

### Governance / honesty
- Advisory/educational only — never places trades, never changes strategy.
- Grounded: reasons only over the user's real data + principles; if data is thin
  (Phase 0, few trades), it says so and coaches on process, not outcomes.

### Surfaces
- `/dashboard/mentor` — a "Coach" panel: run button + latest insight card.
- Briefing v2 — a Mentor block (see features/briefing).
- Visual Agents — Mentor tagged 🤖 AI Agent (done Phase 4).

### API
- `POST /api/agents/mentor-coach` — runs the loop, stores an insight, returns it.
- `GET  /api/agents/mentor-coach` — latest stored insight.

### Storage — `mentor_insights`
`id · grade int · confidence numeric · strengths jsonb · focus_areas jsonb ·
 lesson text · market_note text · next_milestone text · model · tokens_in/out ·
 created_at`. RLS: service all; auth read.
