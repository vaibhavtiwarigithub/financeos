# Feature Architecture: System Health funnel + Model Resilience

## Status

Architecture status: Implemented (P1 + P2 + P3)
Architecture approved: Yes ("build", 2026-07-07)
Approved scope: All three phases
Approved date: 2026-07-07
Implementation allowed: Yes

### Implementation notes (2026-07-07)
- Migration 099: `agent_alerts.issue_key` + partial unique index (one open row per key).
- `lib/system-health.ts`: `reportIssue` / `resolveIssue` / `reconcileIssues`.
- Reporters wired: model-check (deprecated → critical, reachable-provider-aware
  auto-resolve; newer-available → info), AV budget exhaustion (self-expiring),
  kill-switch trips (per market), unreconciled orders (Gateway), Robinhood +
  Kite token expiry.
- Surfaces: `SystemHealthCard` on the dashboard home (persistent, severity-ranked,
  deep-link fix hints; green when clean) + "Open Issues" band in every daily brief.
  DashboardShell severity vocabulary extended with `critical` (top rank).
- Model resilience (`lib/llm-router.ts`): `TIER_MODELS` aliases (fast/reasoning/
  claude-fast/claude-smart), `SAME_TIER_FALLBACK` graceful fallback on an
  unavailable model (loud `model-fallback:` alert, never blind-latest), and
  `priceFor` pricing fallback so cost never silently logs $0.

## Why this feature exists

Tonight's session exposed the core risk of an autonomous-ish trading system:
**silent failures.** Every real problem was invisible until stumbled upon —
DeepSeek models deprecated (agents would've errored on next call), the vault
`display_name`/`provider` NOT-NULL break, the `trade_queue` vs `trade_proposals`
split, the AV budget starving the scorer, the snapshot parse returning nulls.
None surfaced anywhere the user would see them.

Two related gaps:
1. **No unified "open issues until fixed" surface.** Issues are scattered:
   `model-check` and a couple of others post to `agent_alerts`, but most
   subsystems report nothing, there's no dedup/auto-resolve, and there's no
   persistent dashboard panel or brief section that shows OPEN issues until they
   clear.
2. **Model config is brittle.** Concrete model names are hardcoded/stored per
   agent; when a provider renames or deprecates a model, every agent pointed at
   it breaks and must be hand-updated (as just happened). There is no tier
   indirection and no graceful fallback — a deprecated model is a hard error,
   not a flagged degradation.

This feature makes failures **loud and persistent** and makes model config
**break-proof but never silently drifting**. It changes no trading logic.

Existing infra to BUILD ON (do not duplicate):
- `agent_alerts` table: id, created_at, severity, category, title, detail,
  resolved, resolved_at, auto_expire_at.
- `/api/alerts`: GET (open alerts), POST (create), PATCH (resolve).
- Current reporters: `models/check`, `research/cron`, `broker/orders/sync` only.

---

## Phase 1 — Issue funnel: standardized reporting + dedup + auto-resolve

### Problem
`agent_alerts` exists but: (a) most subsystems don't report into it; (b) no
stable dedup key, so a recurring condition would spam duplicate rows (or, as
today, never report at all); (c) no auto-resolve when the condition clears.

### Proposed behavior
- Add `agent_alerts.issue_key text` (a stable identifier for a condition, e.g.
  `model-deprecated:deepseek-reasoner`, `av-budget-exhausted`,
  `kite-token-expired`, `order-needs-reconcile:<orderId>`,
  `cron-failed:kairos-learner`). Migration adds the column + a partial unique
  index on `(issue_key) WHERE resolved = false` so at most one OPEN row per
  condition.
- A shared helper `reportIssue({ issueKey, severity, category, title, detail,
  autoExpireAt? })` — upserts by `issue_key` on open rows (refreshes detail /
  keeps the existing open row rather than duplicating), and
  `resolveIssue(issueKey)` — marks the matching open row resolved. Both
  service-side, used by any subsystem.
- Wire reporters across the app (each reports AND auto-resolves):
  - **Model deprecation** (`models/check`): open an issue per deprecated
    assignment; resolve when the model reappears / is reassigned.
  - **API budget** (`av-cache` / a daily check): open when AV daily budget is
    exhausted; auto-expire next day.
  - **Broker/connection health**: Kite token expired/near-expiry, Robinhood MCP
    token missing/refresh-failing.
  - **Kill switches**: open an issue while a kill switch is tripped; resolve
    when cleared.
  - **Unreconciled orders**: `broker_orders.status = unknown_needs_reconcile`
    opens an issue until the order reconciles.
  - **Cron failures**: a cron that errors or writes 0 where it shouldn't.
  - **Schema drift**: a migration named in the repo not applied to the live DB
    (optional, lower priority).
- Auto-resolve: reporters that run on a schedule resolve their own issue when
  the condition is gone; time-bounded ones use `auto_expire_at`.

### Data model
- `agent_alerts.issue_key text` + `create unique index … (issue_key) where
  resolved = false`. (Verify current indexes first.)

### Acceptance criteria
- A recurring condition produces exactly ONE open `agent_alerts` row (dedup by
  issue_key), not duplicates.
- Resolving the underlying condition auto-clears the issue.
- At least the model-deprecation, budget, broker-token, kill-switch, and
  needs-reconcile conditions report into the funnel.

---

## Phase 2 — Persistent surfaces: dashboard System Health card + brief section

### Problem
Even the issues that ARE in `agent_alerts` aren't shown anywhere persistent —
only reachable by opening a specific card.

### Proposed behavior
- **Dashboard "System Health" card** (top of `/dashboard`, or the status bar):
  reads OPEN `agent_alerts`, shows a count badge (red when any CRITICAL/HIGH),
  grouped by severity + category, each with title/detail and (where possible) a
  one-click "how to fix" hint or deep link (e.g. model-deprecation → Settings →
  LLM Config). Stays visible until issues resolve. Collapsed/green when clean.
- **Daily brief "Open Issues" section** (morning + evening, both markets): lists
  OPEN issues (severity-ranked) so they're in the user's face every day until
  fixed — the thing that would have surfaced tonight's silent breakages on day
  one.
- Owner-only; reads via `/api/alerts` (already exists) or a small
  `/api/system-health` aggregator.

### Acceptance criteria
- Open issues appear on the dashboard persistently and in every daily brief
  until resolved.
- Zero open issues → a clean/green state, no noise.
- Severity ordering: CRITICAL/HIGH first; live-trading-affecting issues
  (broker token, kill switch, needs-reconcile) surfaced most prominently.

### Operational taxonomy correction (2026-07-20)

`agent_alerts` remains the transport for both actionable conditions and bounded
operational telemetry, but the product must not call both "open issues":

- `critical`, `error`, and `warn` are **actions required**, shown expanded and
  counted in the System Health headline;
- `info` is an **operational notice**, collapsed by default and counted
  separately;
- successful agent activity (for example, Theme Scout adding symbols) belongs
  in the agent/watchlist history, not System Health, and must not write an alert;
- expected sparse evidence and free-tier quota exhaustion may remain notices
  because they explain score coverage, but their wording must not imply a broken
  provider or more real calls than the enforced budget allowed.

This changes presentation and activity routing only. It does not suppress real
broker, cron, data-starvation, kill-switch, or reconciliation faults.

---

## Phase 3 — Model resilience: tier aliases + graceful fallback

### Problem
Model names are concrete and per-agent. A provider rename/deprecation hard-
breaks every agent pointed at it (just happened: deepseek-chat/reasoner → V4).
"Always use latest" is NOT the answer for a trading system — a new model
silently changes reasoning quality, output format, and cost, which must never
drift under live financial decisions without review (the model-check's "never
auto-switched, upgrades come from reviews" stance is correct).

### Proposed behavior
- **Tier aliases.** Introduce roles (`fast`, `reasoning`) resolved by ONE small
  mapping (config table or `lib/llm-router.ts` constant) → the current concrete
  model per provider (e.g. fast→deepseek-v4-flash, reasoning→deepseek-v4-pro).
  `agent_config` can reference a tier OR a concrete model. Next provider rename =
  update ONE mapping line, not every agent row.
- **Graceful fallback (break-proof, never silent).** When `callLLM` gets a
  model-not-found / deprecated error (or the model-check has flagged the model),
  the router falls back to a currently-available model of the SAME tier and
  `reportIssue({issueKey:'model-fallback:<agent>', severity:'high', …})` so the
  run completes but the swap is loudly, persistently flagged for review. It does
  NOT silently ride "latest" — the fallback is same-tier and surfaced.
- **Pricing safety.** When a new model is used, if it has no `PRICING` entry,
  cost logging must not silently zero it — fall back to the tier's price and
  flag "pricing unverified for <model>" so `llm_call_log` cost stays meaningful.

### Non-Goals
- No auto-upgrade to the newest model. Model *upgrades* remain a reviewed
  decision (the checker proposes; a human approves), per existing doctrine.

### Acceptance criteria
- A deprecated configured model does NOT hard-break the agent — it falls back to
  a same-tier available model and raises a persistent issue.
- Changing which concrete model a tier maps to is a one-line change.
- No LLM cost is silently logged as $0 due to a missing pricing entry.

## Cross-cutting

- Read-only/advisory surfaces; nothing here trades, sizes, or changes agent
  reasoning beyond swapping a broken model for a same-tier working one.
- Owner-gated APIs; no secrets in alert `detail`.

## Files (indicative, verify before building)
- `supabase/migrations/0NN_agent_alerts_issue_key.sql` (issue_key + partial unique index)
- `lib/system-health.ts` (new — reportIssue/resolveIssue helpers)
- reporters: `app/api/models/check`, `lib/av-cache.ts`, `lib/kite.ts` /
  `lib/robinhood-mcp.ts` (token health), `lib/kill-switches.ts`,
  `app/api/broker/orders(/sync)`, cron routes.
- `components/dashboard/SystemHealthCard.tsx` (new) + dashboard/StatusBar wiring
- `app/api/briefing/generate/route.ts` (Open Issues section)
- `lib/llm-router.ts` (tier aliases + graceful fallback + pricing fallback)
- `app/api/system-health/route.ts` (optional aggregator)

## Approval

Architecture approved: No
Approved scope: None
Implementation allowed: No
