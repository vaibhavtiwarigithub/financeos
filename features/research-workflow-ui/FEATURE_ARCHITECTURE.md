# Research-to-Decision Workflow UI Clarity

**Status:** Approved for implementation by owner (“go”), 2026-10-28
**Owner:** Vaibhav
**Builder:** Codex

## Goal

Make the existing Kairos screens communicate a truthful, understandable path from symbol research through governed decisions and later evidence review. Keep the current page structure and reuse current data and components.

## User journey

1. **Symbol Research** shows the recorded per-symbol research and score history. It is evidence about what the app observed at a research time, not proof that a dimension predicted the later move.
2. **Signals** and **Agents** show outputs, runs, queues, and controls. The Agents page describes actual scheduled/on-demand workflows; it must not imply an always-on self-evolving supervisor unless such a runtime exists.
3. **Learning** is the home for matured, paired predictive-quality evidence (dimension, council, formula, and strategy comparisons) and learning-governance status. Insufficient evidence remains explicitly insufficient.
4. **Strategies** describes rule-based strategy fit/classification only. A fit score is not a forecast, validated edge, or portfolio result. Link to Learning and Backtest for separate evidence.
5. **Paper/Live Portfolio** shows holdings, account state, decisions, and realized book outcomes. It remains distinct from signal fit and predictive IC.
6. **Upgrade Path** retains implementation/producer readiness and blockers; it is not a list of proven investment strategies.

## Sidebar page review

| Existing page | Role in an evidence-led agent system | UI rule |
|---|---|---|
| Home | Daily portfolio/research overview | Link each alert or signal to its evidence owner; do not present a recommendation as a completed action. |
| Markets / Crypto Markets | Broad market and asset-class context | Keep market state separate from symbol-level prediction and realized portfolio results. |
| Paper Portfolio / Live Portfolio | Book state, decisions, protection, and account results | Preserve paper/live separation and account attribution; show decision history alongside the current holdings. |
| Risk Analytics / My Risk Analytics | Exposure and risk summaries | Preserve owner-book versus viewer-connected-account boundaries. |
| Signals | Research outputs and actionable queues | Make status and refusal reasons visible; route predictive-quality questions to Learning. |
| Agents | Actual scheduled/on-demand workflow operations | Show freshness, last result, backlog and errors; never imply a continuous autonomous supervisor without evidence. |
| Learning | Predictive-quality evaluation and controlled challengers | Keep forecast skill, strategy fit, backtest estimates, and portfolio P&L as separate evidence types. |
| Research Journal | Candidate discovery funnel and score history | Explain why candidates entered or were deferred, with the relevant run timestamp. |
| Upgrade Path | Producer/build readiness and evidence gates | An item must name its producer, last successful collection, blocker, and safe next action; an idle item is not “learning.” |
| Symbol Research | Per-symbol recorded dimensions and charts | Show as-of time and formula/model version; link to matured evaluation rather than implying the displayed score predicted later movement. |
| My Watchlist | User-curated candidate tracking | Show latest research freshness; it is not a substitute for systematic discovery coverage. |
| Scanner | Rule-based universe screening | Distinguish screen eligibility from full research, signal qualification, and trade execution. |
| Strategies | Rule-fit catalog and matching | State that rule fit is descriptive; point to Learning and Backtest for separate evidence. |
| Backtest | Historical replay | Keep assumptions, costs, sample coverage and out-of-sample status visible; do not equate fit or in-sample performance with proof. |
| Earnings Calendar | Catalyst timing | Surface event date/source and link to the affected symbol's research and risk context. |
| Mentor / Decision Journal | User education and human decision audit | Keep coaching separate from automated scores; preserve an auditable record of human decisions. |
| Settings | User controls and integration configuration | Keep model/provider, market, and execution settings explicit; no hidden auto-promotion. |

The implementation in this pass changes wording and contextual links where existing UI could overstate what an output means. Existing pages that already honor these rules remain unchanged; this is not a claim that every future agent-supervisor screen has been built.

## In scope

- Improve truthful page names, subtitles, descriptions, and cross-links on existing pages.
- Improve sidebar hints to clarify page purpose and the difference between observed signals, prediction evidence, strategy fit, and realized portfolio outcomes.
- Reuse existing layout, shared `PageHeader`, link components, inline style/T-token convention, and existing routes.
- Preserve the current market switch and US/India page behavior.

## Out of scope

- No new sidebar page, new agent/supervisor, model or prompt changes, new inference, schedules, research producers, score formulas, weights, risk rules, trading settings, account actions, API routes, database/schema changes, packages, or new claim of autonomous behavior.
- No new result or performance claim; no insufficient evidence is promoted.
- Do not redesign Learning or portfolio evidence panels that already distinguish IC from portfolio P&L.

## Acceptance criteria

- The multi-dimension symbol page is named and described as symbol research, not fundamentals alone.
- The Agents page says what it operates and does not suggest persistent/autonomous activity beyond the existing scheduled and on-demand workflows.
- Strategy fit is clearly distinguished from realized predictive and portfolio evidence, with links to the existing Learning and Backtest pages.
- Existing sidebar destinations and permissions remain unchanged; hints truthfully describe their content.
- No runtime/data contract changes. Architecture/status documentation remains aligned with the implementation.

## Verification

Review the diff, run `git diff --check`, and run the repository TypeScript check. No tests are added because this change is presentation-only and the owner did not request test work.
