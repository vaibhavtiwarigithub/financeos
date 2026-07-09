# Settings-driven LLM + API-key control for every flow

**Status: SHIPPED (both parts). 2026-07-08.**
Part 1 — every flow honors `agent_config`: migration 129 reconciled theme-scout/
briefing/mentor rows to their real current model, then wired those callsites to
`getConfiguredModel` (learner + markets-thesis/synthesis + macro-read + backtest-
optimize + health-triage + deep-dive already honored it; `research` keeps adaptive
routing; deepseek A/B stays deepseek). Part 2 — `lib/llm-keys.ts` (`getProviderKey`
vault-first/env-fallback + status/set/clear), owner-gated `app/api/agents/provider-keys`,
router + guards + model-check made vault-aware, Providers card in the LLM Config tab
(write-only, masked, clear-to-revert-to-env).
Last updated: 2026-07-08

## Goal (user ask)
"I should be able to choose the LLM and its API through Settings, so the app can
use them for any flow/agent." One place to pick, per agent/flow: (a) which model,
(b) which provider API key — and have EVERY flow actually obey it.

## Current state (what exists, what's broken)
- `agent_config(agent_name, model, enabled)` table + `getConfiguredModel(svc, name,
  fallback="deepseek-v4-pro")` ([lib/agent-model-config.ts]) — the intended control point.
- Settings → Agents → **LLM Config** tab + the **Model Freshness** panel
  ([app/api/models/check]) read `agent_config`.
- **Gap 1 — not every flow honors it.** Only callsites using `getConfiguredModel`
  obey the setting (markets-thesis, markets-synthesis, macro-read, backtest-optimize,
  health-triage). Others HARDCODE and ignore the config:
  - Theme Scout → `llama-3.3-70b-versatile` (but freshness shows it as deepseek — misleading)
  - Briefing → `deepseek-v4-flash` (x2)
  - Mentor-coach → `deepseek-v4-pro`
  - DeepSeek A/B agent → `deepseek-v4-flash`
  - ResearchAgent → computed `screenModel` (claude-haiku on structured path, else deepseek)
  So the panel implies control the code doesn't actually grant for those flows.
- **Gap 2 — API keys are env-only.** `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` /
  `GROQ_API_KEY` are read from `process.env` inside the router. A user cannot set or
  rotate a provider key from Settings; adding a provider means a Vercel env change +
  redeploy.

## Proposed design

### Part 1 — every flow honors `agent_config` (single source of truth)
- Enumerate every LLM-using flow and give each a stable `agent_name`
  (research, screen, briefing-editor, briefing-outlook, theme-scout, mentor, learner,
  deep-dive, markets-thesis, markets-synthesis, backtest-optimize, macro-read,
  health-triage, deepseek-ab). Seed one `agent_config` row per flow.
- Replace each hardcoded `model:` with `await getConfiguredModel(svc, "<agent_name>")`,
  keeping the CURRENT model as that row's default (behavior-preserving: nothing changes
  until the user edits a row). ResearchAgent's structured-vs-thin branch stays, but both
  branches read their configured model instead of literals.
- The Model Freshness panel then reflects TRUE wiring — every listed agent is one the
  code actually obeys. (Fixes the Theme-Scout=llama-shown-as-deepseek lie.)

### Part 2 — provider API keys settable from Settings (vault-backed)
- Add a **Providers** section to the LLM Config tab: one row per provider
  (Anthropic, DeepSeek, Groq, …) with a masked key field + "Test" button.
- Store keys in the existing **Supabase vault** (same pattern as the Kite/Robinhood
  tokens + `kairos_cron_secret`), NOT in a plain table. Owner-gated write.
- Router key resolution becomes **vault-first, env-fallback**: a small
  `getProviderKey(provider)` reads the vault secret, falling back to `process.env.*`
  so existing env keys keep working with zero migration. `callClaude/callDeepSeek/
  callGroq` call it instead of reading `process.env` directly.
- **Security constraints (hard):** keys are write-only from the UI (never rendered
  back — show only "•••• last4" + set/rotate), owner-gated, stored encrypted in vault,
  never logged, never returned by any GET. Adding/rotating a key is an
  "account-settings"–class action → owner click only, never agent-triggered.

### Part 3 — model dropdown is provider-aware
- The per-agent model dropdown offers the known model ids per provider (from the same
  list Model Freshness already fetches), plus the tier aliases ("fast"/"reasoning").
  Picking a model whose provider has no key surfaces a warning (uses env fallback or
  fails loudly via the existing System Health funnel).

## Touch list (for approval)
- **DB:** seed `agent_config` rows for all flows (data, not schema — additive upsert).
  Vault secrets for provider keys (no new table).
- **lib/llm-router.ts:** `getProviderKey()` vault-first resolution in the three
  `call*` fns; no routing-logic change.
- **~8 route/agent files:** swap hardcoded `model:` for `getConfiguredModel(...)`.
- **Settings LLM Config UI:** add Providers (key set/rotate/test) + provider-aware model
  dropdown; keep per-agent enable toggle.
- **Owner gating + vault read/write helper** (reuse existing vault util).
- **Docs:** SYSTEM_OVERVIEW.md LLM section + system-map.json only if a flow's provider
  changes materially (default-preserving, so likely just SYSTEM_OVERVIEW).

## Non-goals / guardrails
- No autonomous key creation or provider signup — user pastes their own key; the app
  only stores/uses it. (Account-creation + credential-entry stay owner actions.)
- Default-preserving: seeding rows with today's models means nothing changes until the
  user edits. No behavior drift on deploy.
- Does not touch money limits, order paths, or the champion-genome live controls.

## Open decisions for you
1. **Scope now:** do BOTH parts (full: every-flow-honors-config + vault key management),
   or Part 1 only first (make every flow obey config; keep keys in env for now)?
2. **Provider key storage:** Supabase vault (recommended, matches existing secrets) —
   confirm, or prefer a different store?
3. Any flow you want to DELIBERATELY pin (e.g. keep Theme Scout on free Groq/llama
   regardless) rather than expose as user-editable?

No implementation until you approve + answer 1–3.
