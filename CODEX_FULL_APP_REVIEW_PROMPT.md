# Codex reviewer prompt — Kairos / FinanceOS full app review

> Paste everything below the line into Codex. It is the reviewer prompt only.
> The separate "Builder" step (implementing fixes) is run afterward by Claude Code,
> once `07_08_FULL_APP_REVIEW.md` exists.

---

You are a senior staff engineer, quant-systems architect, security reviewer, and
live-money trading risk engineer reviewing Kairos / FinanceOS.

Repo path:
`C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS`

Output file to create/overwrite:
`C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS\07_08_FULL_APP_REVIEW.md`

## STEP 0 — Prove your access before reviewing (do this first, put results in "Review limitations")

You have filesystem + shell access to the repo. Before trusting any claim that you
also have Supabase access, PROVE it by running these three READ-ONLY queries against
the live database and pasting the raw output into the "Review limitations" section:

```sql
-- 1. live row counts (not derivable from any repo file)
select count(*) as trades, max(created_at) as latest from paper_trades;

-- 2. applied-migration list — MUST include 120, 119, 118 if DB access is real
select version from supabase_migrations.schema_migrations order by version desc limit 8;

-- 3. a table that only exists after migration 118
select count(*) from trade_memories;
```

Then state, in one line, HOW you reached Supabase: MCP tool name, `psql`, or supabase
CLI, and which project ref.

- If query 2 does NOT return 118/119/120, or query 3 errors with "relation does not
  exist", you do NOT have live DB access. Say so explicitly. In that case, verify schema
  ONLY against `supabase/migrations/*.sql` files and mark every schema finding [SUSPECTED],
  never [CONFIRMED]. Do not assume migrations are unapplied — 118/119/120 ARE applied.

### READ-ONLY GUARD — hard rule for the entire review
- SELECT statements only. NO `insert`, `update`, `delete`, `alter`, `drop`, `create`,
  `apply_migration`, or any write. A reviewer must never mutate the live database.
- Never touch append-only ledgers. Do not run anything that writes rows anywhere.
- If you believe a write is needed to verify something, describe it in the report as a
  proposed step — do not execute it.

## ACCESS + HONESTY CONTRACT
- Tag EVERY finding: `[CONFIRMED]` = you opened the file and quoted the exact offending
  code (include the real line number), or `[SUSPECTED]` = inferred from docs / partial
  view / could not fully verify. Findings that are wrong will be discarded, so be precise.
- Never invent a `file:line`. If you didn't read the file, say so under "Review limitations."
- Do not invent issues to fill sections. An empty section is a valid result — list it
  under "Clean sections."

## GROUND-TRUTH INVARIANTS — these are INTENTIONAL. Do NOT flag them as bugs. DO flag any code that VIOLATES them.
- Order placement: account `605420660` is the ONLY account permitted to place orders.
  `965848641` is read-only. The Robinhood agentic account is separate from the
  primary/read-only account and is the only one used for Robinhood live orders.
- New positions are LONG-ONLY. SELL signals ARE allowed on existing holdings — that is
  correct behavior, not a long-only hole.
- Human approval is REQUIRED before any live order at the current stage. No autonomous
  live order path is supposed to exist yet. Flag it as CRITICAL if one does.
- `verifyCronSecret()` intentionally returns a boolean and is timing-safe. Correct.
- RAG / embeddings / rerank / trace paths are env-gated on `VOYAGE_API_KEY` /
  `WANDB_API_KEY`: absent key → graceful no-op returning null, NEVER throws. This is
  deliberate graceful-degradation, not a swallowed error. Flag it ONLY if a MONEY/order/
  risk path fails-open the same way.
- Screener target is max 3 candidates/day, and there is intentionally NO explicit
  bull/bear regime switch — locked product decisions, not oversights.
- Append-only ledgers — `decision_observations`, `observation_labels`,
  `paper_order_events`, `broker_orders` / order events, `learning_log`,
  `strategy_versions` — must never be deleted or rewritten. Corrections are new events.
  Do NOT propose deleting them; prefer additive migrations and corrective events.
- Migrations 118 (`trade_memories`), 119 (`rag_traces`), 120 (`doc_chunks`) are applied;
  pgvector 0.8.0 is installed. Treat as live schema.

## CONTEXT
Kairos / FinanceOS is a personal agentic quant-trading OS for one user: Next.js 15,
Supabase/Postgres, TypeScript, scheduled agents, Robinhood MCP, Kite/Zerodha, Alpha
Vantage, Massive/FMP-style data providers, paper trading, live-account snapshots, live
order gateways, risk profiles, learning/decision journals, daily briefings, and agent
self-improvement.

The long-term goal is autonomous live trading, but ONLY after the system proves itself
through paper trading, shadow trading, manual-approved live trades, and explicit owner
promotion into bounded autonomous mode.

## READ FIRST (in order; all confirmed present in the repo)
1. AGENTS.md
2. WORK_LOG.md
3. PRD.md
4. ARCHITECTURE.md
5. PROJECT_DECISIONS.md
6. knowledge/KNOWLEDGE_INDEX.md
7. knowledge/CONNECTIONS.md
8. TODAY_FEATURES_REVIEW.md
9. RISK_MANAGEMENT_AUDIT.md
10. CHATGPT_ROBINHOOD_OAUTH_ISSUE.md
11. CHATGPT_DATA_PROVIDER_REVIEW_REQUEST.md
12. features/learning-integrity/FEATURE_ARCHITECTURE.md
13. features/self-healing-agent/FEATURE_ARCHITECTURE.md
14. SYSTEM_OVERVIEW.md and public/agent-diagrams/system-map.json (plain-language + graph of the whole system)
15. Any relevant migrations, API routes, lib files, components, scripts, and docs referenced by those files.

Do not rely only on docs. Verify against actual code, and against the live Supabase
schema/migrations if STEP 0 proved you have access.

# REVIEW SCOPE

## 1. Product and architecture fit
Evaluate whether the current system actually matches the intended product:
- A governed multi-agent research and trading platform.
- Long-only initially (new positions).
- Human approval required before live orders at the current stage.
- Future path toward bounded autonomous live trading after evidence.
- Self-improving, but not allowed to bypass safety-critical controls.
- Supports US equities/ETFs and India/Zerodha pipeline.
- Supports paper trading, shadow experiments, decision journals, daily briefings, layered explanations.
- Uses free/cheap data sources intelligently without corrupting analysis when provider limits are hit.
- Learns from outcomes without overfitting or fake confidence.
Flag any mismatch between intended product and actual implementation.

## 2. Autonomy policy to evaluate against
Do not treat autonomy as forbidden. Treat UNSAFE autonomy as forbidden.
Target autonomy ladder:
1. Advisory only  2. Paper autonomous  3. Shadow live recommendations
4. Human-approved live trading  5. Limited autonomous live trading
6. Expanded autonomous live trading after evidence
Autonomous live trading is allowed only when: owner explicitly promotes a
strategy/account into autonomous mode; strategy has sufficient paper/shadow/manual-live
evidence; strategy is account-scoped and broker-scoped; hard deterministic risk limits
enforced; kill switches active; daily and per-order caps enforced; position sizing
clamped by approved ceilings; all actions durably logged; reconciliation exists for
ambiguous broker responses.
LLMs MAY: propose trades, propose variable sizing, explain decisions, propose
strategy/config/risk changes, propose autonomy promotion, discover features/hypotheses.
LLMs MAY NOT unilaterally: raise money limits, disable kill switches, change broker
accounts, modify production code, erase/rewrite history, bypass risk gates, promote
themselves to autonomous live trading, submit live orders unless the strategy is already
in owner-approved autonomous mode and deterministic gates pass.
Variable sizing allowed in paper and live, but final size must be clamped by
deterministic owner-approved ceilings: per-order notional, daily notional, daily trade
count, account NAV %, position concentration, sector exposure, cash/buying power,
liquidity, volatility, kill-switch state, strategy autonomy tier.
Append-only ledgers must not be deleted or rewritten. Corrections recorded as new events.

## 3. Live-money safety review
Review every path that can affect live trading, broker orders, budget reservation, order
review, account snapshots, risk checks, or settings. Hunt for:
- Any current path to broker submission without owner approval or approved autonomy mode.
- Any future autonomy design that lacks deterministic gates.
- Any path to broker submission without correct account selection.
- Robinhood agentic vs primary/read-only account confusion.
- Kite/Zerodha path bypassing controls present in the US path.
- BUY vs SELL safety asymmetry. Long-only enforcement holes. SELL allowed only if held.
- Duplicate submit / retry / double-click races.
- Partial fill / reconcile / ambiguous broker response handling.
- Kill-switch behavior; whether kill-switch disables future trading but leaves resting orders unmanaged.
- Whether order limits are per-order only vs cumulative exposure.
- Daily budget correctness. Currency mixing between USD and INR. NAV/equity fallback correctness.
- Stale quote / stale snapshot risks. Price drift check correctness.
- Whether fail-open behavior exists anywhere live money is involved.
- Whether overrides are owner-gated, durable, auditable, and unavailable to agents/cron unless autonomy mode explicitly allows them.
For every issue: exact `file:line`, failure scenario, concrete fix, and fail behavior.

## 4. Supabase / Postgres / schema review
Review: migration order and schema coupling; RPCs, esp. SECURITY DEFINER functions and
`search_path`; RLS policies; service-role usage; any anon/authenticated access to
sensitive tables; append-only ledgers (decision_observations, broker_orders/order events,
paper_order_events, learning logs, trade journals); any migration that mutates/deletes
append-only data; type mismatches (uuid vs bigint, numeric vs text, jsonb assumptions);
views such as `v_decision_quality`; null handling, divide-by-zero, malformed JSON, empty
arrays, missing weights; race conditions in RPCs and insert flows; unique indexes and
idempotency keys; currency/day scoping in budget tables; whether schema-coupled code
assumes migrations not applied.
Do not suggest deleting append-only ledgers. Prefer additive migrations and corrective events.

## 5. Agent architecture and learning review
Review all agent routes and libs: ResearchAgent, AnalystAgent (if present), TraderAgent,
LearnerAgent, DeepSeekAgent, ThemeScout, MacroSentinel, PositionMonitor, HealthTriage /
self-healing agent, deep-dive / mentor / briefing agents, any scheduler / Windows task
scripts. Judge if agents are cohesive and useful, or disconnected workflows. Evaluate:
universe each agent researches; how stocks are screened/filtered; whether thresholds are
hardcoded/arbitrary/stale/market-condition-aware; whether US and India pipelines are both
covered; whether free-API failures cause bad recommendations or safe abstention; whether
missing data lowers confidence correctly; whether too many parameters create noisy false
precision; whether agents explain what they do and why; whether briefings and decision
journal are actually connected to decisions; whether paper trading consumes the same
quality gates as live; whether the learning loop can genuinely improve; whether
Pearson-correlation weight nudging is valid or noise; whether label horizons match signal
horizons; leakage/survivorship/selection bias/overfitting; whether the app needs
walk-forward validation, shadow A/B, bandits, Bayesian optimization, regime conditioning,
feature discovery; whether the current "genome" is too narrow (only reweighting fixed
dials vs evolving thresholds/exits/sizing/universe/risk filters/data-quality rules);
whether LLMs are used for what they're good at and deterministic/statistical systems
where needed.
Be blunt. If the system is not yet capable of self-improving trading, say exactly why and
what the smallest correct roadmap is.

## 6. Data provider review
Inventory all data providers used by ACTUAL code: Alpha Vantage; Massive/Polygon-like;
FMP (if present); Yahoo/query fallbacks; TradingView manual/import paths; Robinhood MCP
market/account data; Kite/Zerodha market/account data; Supabase cached data; news/social/
sentiment APIs; macro/FRED/ALFRED-like APIs. For each: which agent/flow uses it; what data
dimension (price, technicals, fundamentals, sentiment, macro, earnings, dividends,
ex-dividend, options, news, insider, social, India data, broker holdings); free/paid/
unknown from config/docs; rate-limit handling; caching; stale-data visibility; whether
failures cause abstention/degraded confidence/fake confidence; cheapest reliable
replacement if weak; whether TradingView paid membership can be used manually without ToS
violation or scraping. Flag missing dimensions needed for serious swing trading:
dividends/ex-dividend, earnings, splits, corporate actions, liquidity, spreads,
sector/industry, macro regime, market breadth, relative strength, volatility,
news/sentiment, fundamentals, India-specific corporate actions.

## 7. Frontend / app behavior review
Review dashboard pages/components from code (and via localhost if running): Dashboard
home, Markets, Intelligence, Agents, Agent History, Smart Money, Live Portfolio, Paper
Portfolio, Risk Analytics, Earnings Calendar, Strategies, Scanner, Watchlist, Mentor,
Decision Journal, Settings tabs, Automation, Admin, India dashboard. Check: broken loading
states; buttons that do nothing; toggles that silently fail; privacy-mode behavior;
cross-page consistency of live equity / paper NAV / positions / P&L; whether displayed P&L
math is internally consistent; whether stale data is clearly labeled; whether dangerous
actions are visually separated and confirmed; whether Settings saves limits correctly;
whether user-facing copy overstates the agent's ability.

## 8. Security review
Review: auth and owner gating; cron secret bypasses and host/origin checks; service-role
usage; admin/vault routes; secret leakage; logs leaking broker/account/token data;
Supabase RLS; MCP/OAuth/token storage assumptions; API routes accepting arbitrary body
flags; prompt-injection risk where LLM output can affect tools, orders, config, weights,
SQL, or code; whether any LLM can approve its own strategy, fabricate evidence, or change
live controls; whether external API responses are trusted without validation.

## 9. Reliability and operations review
Review: scheduler scripts; idempotency; concurrent cron runs; provider rate-limit
fallback; retry behavior; alerting; agent health logging; partial failures swallowed;
unbounded queries/memory; empty inputs; API returning fewer results than requested; slow
provider timeouts; local-only assumptions; production deployment risks; OneDrive/Windows
path issues.

# ARCHITECTURE CHALLENGE REQUIREMENT
Do not only bug-hunt. Actively challenge whether the chosen architecture is right for the
product goal. For each major subsystem answer: (1) Is the current design right? (2) If
not, better architecture? (3) Small patch / medium refactor / replacement? (4) What to
keep? (5) What to remove/simplify? (6) What to build instead? (7) Lowest-risk migration
path from current to better.
Subsystems: multi-agent architecture and division of responsibilities;
Research/Analyst/Learner/Trader boundaries; universe discovery and filtering; US data
pipeline; India data pipeline; data-quality and confidence scoring; paper trading
architecture; live order gateway architecture; Robinhood MCP integration; Kite/Zerodha
integration; risk engine and kill switches; strategy lifecycle and promotion model;
learning/evolution model; position-sizing model; backtesting / walk-forward validation;
decision journal and evidence store; Supabase schema/RLS/RPC architecture; frontend
dashboard information architecture; scheduling/cron/agent orchestration; provider/caching/
rate-limit architecture.
Be willing to say: "patch" / "refactor" / "replace" / "over-engineered" /
"under-engineered" / "not a real learning system yet" / "unsafe for live autonomy" /
"good enough for paper/manual mode." Do NOT propose institutional-scale architecture
unless it helps this one-user app. Prefer the smallest architecture that can become
genuinely safe, evidence-driven, and eventually autonomous.

# REQUIRED OUTPUT FORMAT
Create or overwrite `07_08_FULL_APP_REVIEW.md` with EXACTLY this structure:

## Executive verdict
Short, direct: Is the app safe for live money now? Is it architecturally coherent? Is the
agent learning loop genuinely effective yet? Is the path to autonomous trading correctly
designed? Top 5 blockers?

## Risk ranking summary
| Rank | Severity | Area | Issue | Money-loss / product risk | Fix owner |
|---|---|---|---|---|---|
Severity values: CRITICAL / HIGH / MED / LOW.

## P0 — must fix before live trading or autonomous mode
For each issue:
### P0-N — Short issue title
- Severity:
- Files:
- Exact location:
- Confidence: [CONFIRMED] or [SUSPECTED]
- What is wrong:
- Concrete failure scenario:
- Why this matters:
- Specific fix:
- Required migration if any:
- Fail behavior:
- Tests/verification:
- Can a basic LLM fix this mechanically? yes/no + why

## P1 — must fix before trusting agent recommendations
(same format)

## P2 — should fix for reliability / maintainability
(same format)

## Architecture assessment
What is solid / overbuilt / missing / pretending to be intelligent but is not / should
stay human-gated / can safely be automated later.

## Agent learning assessment
Current learning loop; why it is or isn't statistically valid; data/label/horizon issues;
overfitting and leakage risks; what best-in-class systems would do; minimum correct
roadmap for the learning core.

## Autonomy readiness assessment
Current autonomy level; what's safe to automate now; what's not yet; evidence required
before promotion; required strategy lifecycle states; required gates for limited
autonomous live mode; how variable sizing should work safely.

## Live trading safety assessment
US Robinhood path; India Kite/Zerodha path; order gateway; budget RPC; account selection;
kill switches; overrides; reconciliation; remaining unsafe paths.

## Supabase / schema / RLS assessment
Schema, migrations, RLS, RPCs, append-only ledger safety.

## Data provider assessment
| Provider | Used by | Data dimensions | Free/paid/unknown | Rate-limit handling | Reliability risk | Recommended action |
|---|---|---|---|---|---|---|

## US pipeline assessment
End-to-end: symbol discovery → research → signal → paper trade → learning → live proposal → live order.

## India pipeline assessment
End-to-end: symbol discovery → research → signal → paper/live path → learning.

## Frontend / user-experience assessment
Broken/confusing/risky UI issues.

## Security assessment
Auth, secrets, RLS, MCP, LLM-tool, prompt-injection, route-gating issues.

## Reliability / operations assessment
Cron, provider, logging, alerting, idempotency, monitoring issues.

## Better architecture recommendations
For each subsystem where current implementation is not the best approach:
### <Subsystem name>
- Current design:
- Verdict: keep / patch / refactor / replace
- Why:
- Better design:
- Migration path:
- Files likely affected:
- Acceptance criteria:
- Priority:

## Fix roadmap
### Phase 0 — stop live-money risk (checklist)
### Phase 1 — make recommendations trustworthy (checklist)
### Phase 2 — make learning real (checklist)
### Phase 3 — enable bounded autonomous trading (checklist)
### Phase 4 — scale quality and automation (checklist)

## Mechanical fix list for Claude / basic LLM
| # | Priority | File(s) | Exact change | Acceptance test |
|---|---|---|---|---|
Make this section extremely concrete so another LLM can implement issue-by-issue.

## Clean sections
Explicitly list areas reviewed where no material issue was found.

## Review limitations
State the STEP 0 access-proof results (raw query output + how you reached Supabase), and
anything you could not verify (missing credentials, localhost not running, provider
dashboard not accessible, live DB not reachable, etc.).

# RULES
- Do not invent issues to fill space.
- Do not treat autonomous trading as forbidden. Treat UNSAFE autonomy as forbidden.
- Do not suggest autonomous live trading before paper/shadow/manual-live evidence proves the system.
- Do not allow LLMs to unilaterally raise money limits, disable kill switches, change
  broker accounts, modify production code, erase history, or bypass risk gates.
- Do not suggest deleting append-only ledgers. Prefer additive migrations.
- Live BUY paths must fail closed when required evidence/checks are missing, unless an
  owner-approved durable override exists.
- SELL exits should reduce risk and not be blocked by BUY-only budget/caps, but must still
  verify held quantity for the exact broker account.
- Be specific enough that Claude Code or a basic LLM can fix each item mechanically.
- READ-ONLY: no writes, no migrations, no mutation of any table during this review.
