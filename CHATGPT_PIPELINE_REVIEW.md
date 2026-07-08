# Review request: full agent pipeline + Robinhood live-trading build + live-trading-hardening spec

You have repo access to the Kairos/FinanceOS codebase (Next.js 15 + Supabase +
Vercel pg_cron, US + India markets). Do a **deep, adversarial architecture +
correctness + security review** of the entire trading pipeline and the new
Robinhood live-trading capability. Trace the ACTUAL code and live behavior — do
not assume the docs are accurate. Read `AGENTS.md`, `PRD.md`,
`ARCHITECTURE.md`, `WORK_LOG.md`, `PROJECT_DECISIONS.md`, `lib/schedule.ts`,
`knowledge/CONNECTIONS.md`, and the files named below.

Flag EVERY issue you find, categorized: **architecture**, **wiring/integration**,
**logic/correctness**, **security**, **data-integrity**, **cost/rate-limit**.
Rank by severity (CRITICAL/HIGH/MED/LOW). For each: file:line evidence, concrete
failure scenario, and the fix. Distinguish confirmed facts from inference.

## Part A — trace the full pipeline end to end

Follow the daily flow across markets and confirm each handoff is wired correctly
(right tables, right market scoping, right order, no silent drops). Agents to
trace (find any I missed):

1. **Theme Scout** (`app/api/agents/theme-scout`) → writes `watchlist`
   (source=llm_theme, 30-day expiry). Runs inline before research.
2. **ResearchAgent** (`lib/research-agent.ts`, `app/api/agents/research/cron`) —
   deterministic 5-dimension scoring (fundamental/technical/sentiment/macro/
   insider) with per-dimension availability + weight renormalization; Groq (free)
   writes only thesis/direction/risks (no LLM-generated numbers); holdings-first;
   dual-bucket screener (momentum/value); champion weights per market;
   India via Yahoo + Kite holdings + india_screen_cache. Writes `agent_signals`,
   `decision_observations`, `research_packets`, `signal_score_history`,
   `pipeline_stage_events`. Chains PaperTrader inline.
3. **PaperTrader** (`app/api/agents/paper-trade`) — half-Kelly sizing
   (`lib/risk/sizing.ts`), Portfolio Constructor risk budgeting
   (`lib/portfolio/constructor.ts`: name/sector/gross/vol/correlation caps),
   kill switches (`lib/kill-switches.ts`), transactional fill RPC
   (`execute_paper_fill`), per-market pools. Writes `paper_trades`,
   `paper_positions`, `paper_performance`.
4. **PositionMonitor** (`app/api/agents/position-monitor`) — exits: trailing
   stop at the position's own MAE-derived distance (`initial_stop_loss`),
   target-hit, daily score-based exit with hysteresis. App-side only.
5. **TraderAgent** (`app/api/agents/trader`) — builds `trade_proposals`
   (long-only, always pending_approval, earnings blackout, MacroSentinel
   threshold raise, half-Kelly sizing). Human approves.
6. **Execution Gateway** (`app/api/broker/orders`) — the live/paper order
   submit path; broker registry (`lib/brokers/registry.ts`) → adapters
   (alpaca/kite/robinhood_mcp). Gates: owner, CSRF, explicit env,
   both-direction broker.envs, kill switches, notional cap (fail-closed),
   fresh-quote drift, sell-only-if-held, fail-closed account allowlist,
   dup-submit unique index, needs_reconcile on ambiguous place.
7. **LearnerAgent** (`app/api/agents/learner`) — weekly, per-market
   (`market` param), evidence-bound weight mutations (server recomputes the
   observation-ledger correlation; ±0.05 clamp; immutable `strategy_versions`
   challengers; validation-gated promotion). Also `feature_registry`
   self-proposed features, `learning_priors`, `learning_priors_history`.
8. **Validation Engine** (`lib/validation/*`) — walk-forward + block bootstrap
   gate for challenger→champion promotion.
9. **MacroSentinel** (`app/api/agents/macro-sentinel`) — weekly econ data
   (GDP/CPI/unemployment/payrolls/retail/fed-funds/yields) → `macro_regime`.
10. **Agent Mind** (`app/api/agent-mind/*`) — Beliefs/Brain/macro-read
    (read-only/advisory; no LLM mutates beliefs).
11. Briefings, nav-snapshot, rescore, label-maturation, fit-calibration,
    feature-check, mentor-coach, broker-sync, proposal-reminder,
    scan-india-refresh, live-account snapshot refresh.

For Part A specifically check: (a) market scoping — does any query leak US↔India
data or apply a global flag where it should be per-market? (b) do the two
Kelly implementations agree and are units correct? (c) does anything still read
the legacy `trade_queue` table while the Gateway uses `trade_proposals`
(the Smart Money UI + `/api/markets/smart-money`)? (d) idempotency across
double-fires and the per-day guards; (e) does the learning loop actually close
(observations → labels → correlation → weights → champion → research)?

## Part B — Robinhood MCP live-trading build (the new real-money path)

Review `lib/robinhood-mcp.ts`, `lib/brokers/adapters/robinhood-mcp.ts`,
`app/api/robinhood-mcp/{login,callback,status,disconnect}`, and the Gateway.
This path is LIVE (first real order placed). Key facts:

- OAuth 2.1 public client (PKCE S256), dynamic RFC 7591 registration; Robinhood
  returns a GENERIC shared client_id. The grant only completes via a
  `http://localhost` loopback redirect (native-MCP-client pattern) — a remote
  Vercel https redirect fails at grant issuance. So Connect must be done once on
  localhost; tokens land in the shared `api_key_vault` and the cloud app reuses
  them; refresh is server-side.
- Deterministic write path: `tools/list` → `review_equity_order` →
  `place_equity_order` via typed `callTool`. NO LLM in the write path.
  `buildArgsFromSchema` discovers the tool schema at runtime, coerces values to
  the schema's declared json type (Robinhood wants `quantity` as a STRING),
  and FAILS CLOSED if a required field can't be mapped. `extractOrderId` parses
  the nested/escaped MCP text content (`data.order.id`). `review_equity_order`
  echo-check before place. Ambiguous place → `needs_reconcile` (no auto-retry).
- Token vault: `api_key_vault` is service-role-only (migration 089);
  `display_name`/`provider` are NOT NULL (vaultSet must set them).
- Kill switches: `robinhood_mcp_enabled` (default off), `trading_enabled` +
  per-market `trading_enabled_us/india`, `max_order_notional`, account allowlist
  (`broker_accounts`, role=trading, fail-closed), hardcoded agentic account
  605420660.

Scrutinize HARD: (1) token security — refresh CAS correctness, no token in
logs/URLs/`raw_last_state`, state-cookie HMAC (`OAUTH_STATE_SECRET`); (2) can
any path place/duplicate an order bypassing a gate? (3) the runtime-schema arg
mapping — can it still emit a valid-but-wrong order (units, enum spelling,
dollar-vs-share, market-vs-limit) despite the type coercion + review echo?
(4) partial fills / order-status (the adapter `getOrder` is a stub today);
(5) the localhost-loopback token model — security implications of a long-lived
token in the shared vault used by cloud; what happens on refresh-token rotation.

## Part C — the live-trading-hardening spec

Read `features/live-trading-hardening/FEATURE_ARCHITECTURE.md` (Draft). Assess:
is the phasing right? Is Phase 1 (trade_queue→trade_proposals consolidation) the
correct fix or is there a deeper redesign? Is Phase 5 (broker-side protective
stops) feasible given Robinhood's MCP order schema — does `place_equity_order`
support `type:stop`/`stop_price` or bracket/OCO? Is anything mis-prioritized,
missing, or dangerous? Is deferring autonomous mode + limit orders correct?

## Part D — DeepSeek research agent: how does it connect, and what's right?

`app/api/agents/deepseek-research/route.ts` + `lib/deepseek-agent.ts` run a
DeepSeek single-symbol researcher that writes a signal; it is admin/on-demand
and NOT on the cron schedule (migration 052 unscheduled the legacy job). The
MAIN pipeline uses the deterministic ResearchAgent with Groq for prose, not
DeepSeek. DeepSeek is used for advisory features + macro-read via `callLLM`
routing (`lib/llm-router.ts`, `agent_config`).

Answer precisely: (1) Is `deepseek-research` dead/orphaned, redundant with the
main ResearchAgent, or a legitimate alternate path? (2) Does it write to the
same `agent_signals` the pipeline consumes — and if so, could it inject signals
that bypass the deterministic scoring / availability-weighting the main path
enforces (a correctness/consistency hole)? (3) What's the RIGHT architecture —
remove it, gate it clearly as a manual research tool, or integrate DeepSeek as a
selectable model for the main ResearchAgent thesis step? Recommend one, with
reasoning, consistent with the app's doctrine ("LLMs generate hypotheses,
statistics validate; no LLM-generated numbers drive trades").

## Output

Numbered, severity-ranked findings per category, each with file:line, failure
scenario, and fix. Then a short "biggest risks before trading real money at size"
summary, and your Part D recommendation.

---
**Write your answer to:** `CHATGPT_PIPELINE_REVIEW_RESPONSE.md`
