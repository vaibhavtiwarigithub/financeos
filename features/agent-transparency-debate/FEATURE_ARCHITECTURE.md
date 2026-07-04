# Feature: Agent Transparency + Deep-Dive Debate

Status: DRAFT (Phase 1 in progress) · Owner: Vaibhav · Started 2026-07-04

## Motivation
Competitor trading-agents.ai (TradingAgents framework) produces an *argued*
per-symbol verdict via an adversarial multi-agent debate. Kairos currently
produces only a numeric `analyst_score`. This feature closes that gap while
keeping Kairos's edge (loop closure, governance, automation).

## Phases
1. **Deep-Dive Debate engine** + per-symbol panel  ← current
2. Agent history/transparency page (#12)
3. Score trajectory + re-scoring (#13)
4. Visual Agents audit + AI-agent vs Flow rename (#14)

---

## Phase 1 — Deep-Dive Debate

### Pipeline (on-demand, per symbol)
```
Data bundle (quote, fundamentals, technicals, macro regime, prior signals)
        │
        ▼
Analyst layer (parallel):  Market/Technical · Sentiment/News · Fundamentals · Macro
        │  (4 short reports)
        ▼
Research debate:  Bull advocate  vs  Bear advocate  →  Research Evaluator (lean)
        │
        ▼
Risk debate:  Risky / Neutral / Safe  →  risk summary
        │
        ▼
Portfolio Manager  →  VERDICT (BUY/HOLD/SELL/PASS) + conviction + rationale
```

### Model routing (no ANTHROPIC_API_KEY available)
- Analysts + advocates: `deepseek-chat` (cheap, parallel)
- Research Evaluator + Portfolio Manager: `deepseek-reasoner` (better reasoning)
- Cost ~$0.05–0.15 per run. **On-demand only** (button) — never auto/cron.

### Governance
- Long-only aware: for a non-held symbol the verdict is BUY or PASS (never SELL).
- Advisory only: verdict may flag high conviction into the pipeline but the
  deterministic risk gate + approval-required order flow remain authoritative.

### Storage — table `deep_analyses`
`id uuid pk · symbol · verdict · conviction int · summary · reports jsonb
 (per-agent) · model · tokens_in · tokens_out · cost_usd · created_at`
RLS: service_role all; authenticated read.

### API
- `POST /api/agents/deep-dive { symbol }` — runs the pipeline synchronously,
  stores a `deep_analyses` row, returns the full result. Auth: user or cron.
- `GET  /api/agents/deep-dive?symbol=X` — latest stored analysis for the symbol.

### UI — `DeepDivePanel` on the symbol page
- "Run Deep Analysis" button.
- Agent pipeline list with status; each agent row expands to its report.
- Final verdict card (verdict, conviction, rationale).
- Shows model + token/cost footer.

### Non-goals (Phase 1)
- Streaming progress (synchronous run; loading state in UI).
- Multi-market (US first; India/EU rides with the watchlist workstream).
- Auto-feeding analyst_score (advisory display first; wiring in a later phase).
