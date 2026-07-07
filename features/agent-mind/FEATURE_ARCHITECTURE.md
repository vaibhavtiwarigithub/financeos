# Feature Architecture: Agent Mind — surfacing what the agents believe, how it evolves, and what macro data means for the book

## Status

Architecture status: Implemented (all 3 phases), 2026-07-07
Architecture approved: Yes (user, 2026-07-07)
Approved scope: All three phases
Approved date: 2026-07-07
Implementation allowed: Yes

## Implementation notes (2026-07-07)
- Migration 096: `learning_priors_history`, `unique(category, principle)` on
  learning_priors, `macro_interpretations`. Migration 097: daily macro-read
  crons (us/india). All new tables service-role-only.
- `strategy_versions` already had `parent_version_id` — no schema add needed.
- Phase 1: `/api/agent-mind/priors` (GET/PATCH, owner-only) + Intelligence
  "Beliefs" tab (view/toggle/add; every change writes history + decision_journal).
- Phase 2: `/api/agent-mind/brain` (GET, owner-only) + Intelligence "Brain" tab
  (champion weights + why, belief drift, learner log, self-invented features,
  regime posture, track record, evidence-context banner). Pure DB reads.
- Phase 3: `/api/agent-mind/macro-read` (GET owner / POST owner+cron) + Markets
  "What this means for your book" card. One cheap cached LLM call/day/market.
- No LLM writes any belief; nothing here trades or sizes.

## Why this feature exists

Kairos already *forms a view of the market* — it just keeps that view scattered
across tables no human reads directly. As the system runs:

- `learning_priors` confidences are meant to drift as predictions resolve
  (background beliefs like "12-1 momentum works", "widening credit spreads lead
  equity weakness").
- `strategy_versions` accumulates challenger weight-sets; one per market is the
  promoted `is_champion` — the app's current working theory of how much each
  scoring dimension should matter.
- `signal_weights` holds the live per-dimension weights the ResearchAgent
  actually scores with.
- `learning_log` records the LearnerAgent's weekly hypotheses and outcomes.
- `feature_registry` holds machine-proposed new features and their IC-gated
  promotion state.
- `macro_regime` / `macro_signals` hold the current macro posture and the raw
  economic prints behind it.
- `decision_observations` + `paper_trades` are the ground-truth outcomes that
  earn or destroy confidence in all of the above.

The user cannot see any of this as a coherent, evolving "mind". This feature
surfaces it — read-only, advisory — so the user can (a) see and curate what the
agents believe, (b) watch beliefs strengthen/weaken over time and learn the
market alongside the system, and (c) understand what a fresh economic print
means for the actual book.

This is a VIEWING/curation layer. It never places trades, never changes sizing,
and never lets an LLM mutate a belief — belief changes stay owned by the
evidence-bound LearnerAgent (weekly, statistics-gated). Any LLM used here writes
display text only.

## Non-Goals

- No new autonomous behavior. Nothing here trades, sizes, or approves.
- No LLM-driven mutation of `learning_priors`, `signal_weights`, or
  `strategy_versions`. Only the existing LearnerAgent (evidence-bound, weekly)
  changes beliefs. This feature can let the USER manually toggle a prior's
  `enabled` flag or edit its text — a human action, logged — but the LLM never
  does.
- No new market-data spend on the hot path. Macro interpretation (Phase 3) runs
  only when macro data refreshes (already daily) or on an explicit user click,
  on a cheap model (DeepSeek/Groq), never per-page-load.
- No change to how confidence is computed. This feature reads the confidence
  the LearnerAgent already maintains; it does not invent a parallel scoring.

## Phased scope

The three pieces share data sources and a UI home, but are independently
approvable and shippable. Recommended order: Phase 1 (foundation the others
read) → Phase 2 (Brain) → Phase 3 (macro interpretation).

---

## Phase 1 — Agent Beliefs panel (surface + curate `learning_priors`)

### Purpose
A readable, editable table of every prior the agents reason from, grouped by
category, showing confidence, source, enabled state, and — once history exists —
how the confidence has moved.

### Data sources (all existing)
- `learning_priors` (id, category, principle, confidence, source, enabled,
  notes, created_at).
- Optional new `learning_priors_history` (see below) to chart confidence drift.

### Proposed behavior
- New tab under `/dashboard/intelligence` (or a card on Settings → Agents):
  "Agent Beliefs". Groups priors by category (fundamental / technical / macro /
  insider / general), each row showing the principle text, a confidence bar,
  source tag, and an enabled toggle.
- Owner-only. Read via a new `GET /api/agent-mind/priors` (service client,
  `requireOwner`). Toggle/edit via `PATCH /api/agent-mind/priors` (owner-only,
  logs the change to `decision_journal` as a human action).
- A small "add prior" form (category, principle, starting confidence, source)
  so the user can feed a distilled principle from a book/article directly —
  exactly one testable claim per row, matching the ingestion discipline.
- Sorting by confidence; filter by category; search.

### New schema (Phase 1)
- `learning_priors_history` (prior_id, confidence, changed_at, changed_by
  ('learner' | 'user'), reason) — append-only, written whenever a prior's
  confidence or enabled state changes. Lets the UI chart drift and the Brain
  view (Phase 2) show "strengthening / weakening". The LearnerAgent's existing
  prior-update path writes a row here; the user-edit path writes one too.
- Migration also de-duplicates and adds a `unique(category, principle)`
  constraint to `learning_priors` (a bug this session left it with every row
  doubled — already cleaned in data, but the constraint prevents recurrence).

### Acceptance criteria
- Every prior visible, grouped, with confidence + source.
- Owner can toggle enabled / edit text / add a prior; each change logged.
- No LLM writes to `learning_priors`.
- `unique(category, principle)` prevents duplicate priors.

---

## Phase 2 — Kairos Brain (the unified, evolving belief view)

### Purpose
One page that answers "what does the system believe right now, how sure is it,
and how has that changed?" — stitched from the separate tables into a single
human-readable, evolving narrative. This is the piece that lets the user learn
the market alongside the agents.

### Data sources (all existing unless noted)
- `learning_priors` + `learning_priors_history` (Phase 1) — background beliefs
  and their drift.
- `strategy_versions` where `is_champion` per market — the current working
  theory: the promoted weight-set, its `notes` (why it was proposed), its
  validation stats, and its parent lineage (how the champion has changed over
  generations).
- `signal_weights` — the live per-dimension weights actually scoring today.
- `learning_log` — recent hypotheses the LearnerAgent formed and whether they
  were confirmed, rejected, or still open.
- `feature_registry` (+ `_history`) — features the system proposed for itself
  and their IC-gated promotion state (the app inventing new signals).
- `macro_regime` — current regime posture and danger score.
- `decision_observations` + `paper_performance` — the outcome ledger that earns
  all of the above its confidence, plus realized alpha.

### Proposed behavior — sections on `/dashboard/intelligence` "Brain" tab
1. **Current conviction** — the champion weight-set per market as a readable
   bar ("fundamental 32%, technical 24%, macro 18%, sentiment 14%, insider
   12%") with a one-line "why this is the current theory" from the champion's
   `notes`, and how it differs from the previous champion (lineage diff).
2. **Strengthening vs. weakening beliefs** — priors whose confidence rose or
   fell most over the last N weeks (from `learning_priors_history`), each with
   the direction and magnitude. This is the "the system is becoming more/less
   sure of X" view.
3. **Open hypotheses** — what the LearnerAgent is currently testing (from
   `learning_log`), with status (open / confirmed / rejected) and the evidence
   count behind each.
4. **Self-invented features** — anything in `feature_registry` the system
   proposed and where it sits in the IC-gate pipeline (proposed → testing →
   promoted / killed).
5. **Regime posture** — current `macro_regime` with the danger score and the
   threshold adjustment it's currently imposing on new trades.
6. **Track record honesty** — realized alpha, win rate, and the count of
   resolved predictions, so the confidence is contextualized by how much
   evidence actually exists (avoid false authority when N is small).

### Read path
- `GET /api/agent-mind/brain` (owner-only, service client) — one aggregated
  payload assembled server-side from the tables above. No LLM required for the
  structured view. An OPTIONAL "explain in plain English" button calls a cheap
  model to narrate the current state (advisory text only, never persisted as a
  belief).
- Purely read-only. No writes.

### New schema (Phase 2)
- None required beyond Phase 1's `learning_priors_history`. Everything else
  already exists. (If champion lineage isn't already queryable via a parent_id
  on `strategy_versions`, add one — to confirm against live schema first.)

### Acceptance criteria
- Single page shows current champion weights + why, belief drift, open
  hypotheses, self-invented features, regime posture, and track-record context.
- Every number traces to a real table; nothing is LLM-invented.
- Small-N guardrail: confidence is always shown next to the evidence count so a
  belief with 3 resolved trades never reads as authoritative.

---

## Phase 3 — Macro-to-holdings interpretation (Markets page)

### Purpose
Turn the macro data the app already ingests into a plain-language read of what a
fresh print means, combined with the other macro signals AND the current book —
the missing "so what does this mean for me" layer.

### Data sources (all existing)
- `macro_signals` / `macro_regime` — the economic prints (GDP, CPI, unemployment,
  payrolls, retail sales, Fed funds, 2Y/10Y yields) and the regime.
- `paper_positions` (+ live snapshot) — the current book, its sector/beta mix.
- `learning_priors` (macro category) — the durable macro principles to reason
  with (e.g. "rising real yields headwind long-duration growth").

### Proposed behavior
- A "What this means for your book" card on the Markets page, generated when
  macro data refreshes (daily, already scheduled) or on an explicit user click —
  NEVER on every page load.
- Deterministic inputs assembled server-side (latest prints + regime + book
  composition + relevant macro priors), handed to a cheap model
  (DeepSeek/Groq) to produce a short, grounded read: "CPI hotter than expected +
  real yields rising + you hold 3 long-duration growth names (NVDA, …) → near-
  term headwind for that cluster; the macro priors flag this at confidence
  0.66." Advisory only.
- Cached per macro-refresh so it costs at most one cheap LLM call/day.

### Guardrails
- The model receives DATA, never instructions, and its output is display text
  only — it cannot change sizing, thresholds, or any belief. It is explicitly
  told the numbers are ground truth and it may not invent figures.
- Account numbers and any secrets are never in the prompt.
- If the model is unavailable, the card degrades to the raw macro data + regime
  (which the Markets page already shows) — no hard failure.

### New schema (Phase 3)
- Optional `macro_interpretations` (date, market, content, model, created_at) to
  cache the daily read. Or reuse the existing briefings/newsletter pattern.

### Acceptance criteria
- Card appears only after a macro refresh or explicit click; at most one cheap
  LLM call/day.
- Output ties the print to the regime, the macro priors, and the actual book.
- No LLM output changes any trading behavior; degrades gracefully if the model
  is down.

## Cost summary

- Phase 1 & 2: zero LLM on the structured views (pure DB reads); optional
  "explain" buttons are on-demand cheap-model calls only.
- Phase 3: at most one cheap-model call per macro refresh (daily), cached.
- No new market-data API spend on any hot path.

## Files (indicative, to confirm against live code before building)

- `app/api/agent-mind/priors/route.ts` (new — GET/PATCH, owner-only)
- `app/api/agent-mind/brain/route.ts` (new — GET, owner-only)
- `app/api/agent-mind/macro-read/route.ts` (new — Phase 3, owner-only + cron)
- `components/dashboard/IntelligencePage.tsx` (modify — Beliefs + Brain tabs)
- `components/dashboard/MarketsPage.tsx` (modify — Phase 3 card)
- `supabase/migrations/0NN_agent_mind.sql` (new — learning_priors_history,
  unique(category,principle), optional macro_interpretations, optional
  strategy_versions.parent_id if absent)
- LearnerAgent prior-update path (modify — also append to
  learning_priors_history when it changes a confidence)

## Approval

Architecture approved: No
Approved scope: None
Implementation allowed: No
