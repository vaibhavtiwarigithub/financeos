# Project Decisions â€” Kairos

## Purpose

Records approved product, architecture, UX, technical, and business decisions.

Only approved decisions belong here. Proposed decisions live in PROJECT_BUILD_LOG.md until approved.

## Decision Template

```
### Decision <N>: <Title>

Date:
Status: Approved
Category: Product / UX / Architecture / Technical / Business / Data / Security

Context:
Decision:
Reason:
Alternatives considered:
Impact:
Files/features affected:
Reversal cost: Low / Medium / High
```

---

### Decision 1: Governed Multi-Agent Quant Platform

Date: 2026-06-27
Status: Approved
Category: Product / Architecture / Security

Context: Kairos needs to research continuously, run experiments, explain decisions, and eventually execute through the Robinhood agentic account without allowing probabilistic AI reasoning to bypass financial controls.
Decision: Separate Data, Research, Analyst, Validation, Strategy Registry, Paper Execution, Learner, Risk/Tax, Explainer, and Live Trade Gateway responsibilities. LLMs may propose and explain; deterministic services calculate prices, P&L, validation, risk, tax flags, and execution state.
Reason: Reproducibility, fault isolation, auditability, and safety are required before paper evidence or live execution can be trusted.
Alternatives considered: Single adaptive super-agent; batch-only quant laboratory.
Impact: Replaces the current prompt-driven loop with governed contracts and lifecycle states.
Files/features affected: `features/agentic-quant-platform/FEATURE_ARCHITECTURE.md` and future phased implementation files.
Reversal cost: High

### Decision 2: Initial Trading Scope and Live Authority

Date: 2026-06-27
Status: Approved
Category: Product / Security / Business

Context: The initial system must align paper behavior with the Robinhood agentic cash account while preserving a safe path to future automation.
Decision: Use long-only 2-20 market-day swing strategies over Robinhood-supported US equities and ETFs that pass quality filters. Every initial live order requires Vaibhav's explicit approval. Future auto-live requires a separate strategy-specific, capital-limited, time-bounded manual unlock and cannot be enabled by an agent.
Reason: Aligns research with executable reality and prevents silent expansion of trading authority.
Alternatives considered: Long/short paper strategies; unrestricted Robinhood universe; immediate auto-live.
Impact: Shorts, options, leverage, crypto, intraday trading, and non-agentic accounts are excluded.
Files/features affected: Strategy Registry, paper execution, Risk Engine, Live Trade Gateway, and trading UI.
Reversal cost: Medium

### Decision 3: Evidence, Data, and Online Research Policy

Date: 2026-06-27
Status: Approved
Category: Data / Architecture

Context: Current prototype routes ask an LLM for prices and unsourced scores, which invalidates P&L and experimental evidence.
Decision: Use free-first replaceable data adapters, point-in-time append-only evidence, source provenance, and abstention when required data is missing or contradictory. Primary and curated sources establish evidence; broad web/social sources may generate hypotheses only. TradingView is a manual analysis/import tool, not an unattended API.
Reason: Market evidence must be deterministic, timestamped, reproducible, and auditable.
Alternatives considered: LLM-mediated data retrieval; a hardwired single provider; unrestricted web evidence.
Impact: LLM-generated authoritative prices are prohibited and current paper results require stabilization before being trusted.
Files/features affected: Data Hub, evidence store, provider adapters, current agent routes, and paper accounting.
Reversal cost: High

### Decision 4: Controlled Self-Improvement and Strategy Promotion

Date: 2026-06-27
Status: Approved
Category: Architecture / Data / Security

Context: Direct weight changes from individual trades chase noise and allow a LearnerAgent to alter production behavior without sufficient evidence.
Decision: LearnerAgent creates immutable challenger versions. A deterministic Python Validation Engine applies a dynamic statistical evidence gate. Risk may veto deployment. Vaibhav alone promotes an eligible challenger to champion.
Reason: Self-improvement must follow a falsifiable, reproducible experiment lifecycle and preserve failed evidence.
Alternatives considered: Fixed time/trade thresholds; direct weekly weight mutation; fully manual evidence review with no system gate.
Impact: Introduces Strategy Registry, experiment artifacts, eligibility reports, and champion/challenger governance.
Files/features affected: Agent learning, validation worker, strategy persistence, paper engine, and review UI.
Reversal cost: High

### Decision 6: MacroSentinel â€” Advisory-Only Regime

Date: 2026-06-29
Status: Approved
Category: Product / Architecture

Context: MacroSentinel computes a recession danger score and regime (GREEN/YELLOW/ORANGE/RED) from 8 macro indicators. The question was whether to auto-throttle agents or halt trading when regime worsens.
Decision: Advisory-only. MacroSentinel reports regime and shows it on the dashboard. It does NOT auto-throttle agents, reduce position sizes, or halt PaperTrader.
Reason: Auto-throttle without the user first observing a live run creates surprising behavior. Vaibhav reviews the regime card and decides whether to act â€” e.g., manually tightening the risk profile or pausing trading.
Alternatives considered: Auto-throttle on ORANGE/RED; auto-reduce position_size_pct when score > 50.
Impact: MarketsPage gauge + DashboardHome banner are display-only. No agent behavior changes automatically based on macro regime.
Files/features affected: `/api/agents/macro-sentinel`, `macro_regime`, `macro_signals`, MarketsPage, DashboardHome
Reversal cost: Low (adding auto-throttle later is additive)

---

### Decision 7: Mermaid v10 (not v11)

Date: 2026-06-29
Status: Approved
Category: Technical

Context: AgentDiagram.tsx uses Mermaid to render flowcharts. Mermaid v11 was installed initially.
Decision: Pin mermaid to v10.
Reason: Mermaid v11 depends on es-toolkit, which is ESM-only and incompatible with Next.js webpack bundler. Build failed with module resolution errors. v10 does not have this dependency and builds cleanly.
Alternatives considered: Dynamic import workaround for v11 (fragile, not worth it).
Impact: Agent diagrams render correctly. No feature difference between v10 and v11 for our use case.
Files/features affected: `package.json`, `components/dashboard/AgentDiagram.tsx`
Reversal cost: Low

---

### Decision 8: Insider Scoring as LLM Context Injection (Not Score Override)

Date: 2026-06-29
Status: Approved
Category: Architecture

Context: ResearchAgent needed to incorporate insider transaction signals (Form 4-equivalent via Alpha Vantage INSIDER_TRANSACTIONS).
Decision: `scoreInsider()` computes a 90-day buy/sell ratio from insider transactions and injects the result as pre-fetched context text in the LLM prompt. The LLM weighs it alongside other signals. It is NOT added as a hardcoded numeric score component.
Reason: LLM can weigh insider data contextually (e.g., a CEO buy during market panic is more meaningful than a routine RSU sale). Hardcoding it as a fixed weight component removes that nuance.
Alternatives considered: Add `insider_buying` as a fixed-weight signal in the signal_breakdown JSON.
Impact: Insider data informs every ResearchAgent run without locking a specific weight.
Files/features affected: `lib/research-agent.ts`
Reversal cost: Low

---

### Decision 9: Risk Profile Presets (Conservative / Balanced / Aggressive)

Date: 2026-06-29
Status: Approved
Category: Product / Data

Context: Strategy config needed user-selectable risk modes to control score thresholds, position sizing, stops, and targets.
Decision: Three named presets stored in `strategy_config`:
- Conservative: score_threshold=72, position_size_pct=7, stop_loss_pct=5, target_pct=12
- Balanced: score_threshold=60, position_size_pct=10, stop_loss_pct=7, target_pct=20
- Aggressive: score_threshold=52, position_size_pct=15, stop_loss_pct=10, target_pct=35
User can select a preset or edit fields individually.
Reason: Named presets make risk configuration intuitive. Per-field override preserves flexibility.
Alternatives considered: Single numeric "risk tolerance" slider; no presets (all manual).
Impact: ResearchAgent reads `score_threshold` from strategy_config; PaperTrader reads `position_size_pct` and `stop_loss_pct`.
Files/features affected: migration 027, `/api/settings/risk-profile`, Settings page, `lib/research-agent.ts`, PaperTrader
Reversal cost: Low

---

### Decision 10: House Stock Watcher for Congressional Trades (not Quiver Quant)

Date: 2026-06-29
Status: Approved
Category: Data / Technical

Context: Smart Money Trades feature needed congressional stock disclosure data.
Decision: Use House Stock Watcher public S3 endpoint (free, no auth, public domain data).
Reason: Free and publicly maintained. Quiver Quant charges for the same underlying public disclosure data. No auth token management needed.
Alternatives considered: Quiver Quant API (paid), SEC EDGAR EDGAR-Online (complex parsing).
Impact: Congressional trades tab in MarketsPage powered by House Stock Watcher JSON feed.
Files/features affected: `/api/markets/insider-trades/route.ts`
Reversal cost: Low (drop-in replacement if Quiver Quant becomes preferable)

---

### Decision 5: Explainability and Evolving Rule Governance

Date: 2026-06-27
Status: Approved
Category: Product / UX / Security

Context: Vaibhav wants to understand what the system thinks, plans, and learns while market, dividend, tax, regulatory, and broker rules evolve.
Decision: Provide a layered decision journal and daily briefing. Automatically update validated market observations and corporate events. Tax, regulatory, broker, risk, and behavior-changing rule updates are versioned, impact-assessed, and require governed review; risk and execution policy never change silently.
Reason: Continuous learning must remain understandable and must not silently broaden financial authority.
Alternatives considered: Chat-only explanations; static reports; unrestricted automatic rule updates.
Impact: Adds evidence labels, rule-version review, tax/dividend flags, and auditable user decisions.
Files/features affected: Explainer, knowledge store, daily briefing, decision journal, Risk/Tax Engine, and rule monitoring.
Reversal cost: Medium

### Decision 11: RAG Memory for LearnerAgent (Voyage embeddings + pgvector)

Date: 2026-07-03
Status: Approved
Category: Architecture / Data

Context: LearnerAgent reasons over historical trade decisions but keyword/filter queries miss semantically-similar situations across different symbols and regimes (e.g. "rate-hike sell-off", "earnings-miss hold").
Decision: Store one Voyage `voyage-finance-2` (1024-dim) embedding per enriched `trade_decisions` row in `trade_decision_embeddings` (migration 045, HNSW cosine index). Expose `semantic_search_decisions` as a LearnerAgent tool backed by the `semantic_search_trade_decisions` RPC. Enrichment is treated as final, so a decision is embedded once and never re-embedded (content_hash retained for audit only).
Reason: Vector recall lets the learner find shared failure modes across similar past trades regardless of ticker/wording. Enrichment-final avoids a re-embed loop and keeps the pipeline idempotent.
Alternatives considered: LLM re-reading all history each run (token-expensive, lossy); keyword search only (misses semantic matches); re-embed on any content change (needless churn given enrichment is final).
Impact: Adds an embeddings table, an embed route, two RPCs, and a `VOYAGE_API_KEY` dependency (route 503s without it).
Files/features affected: `supabase/migrations/045_*`, `047_*`; `app/api/live-portfolio/embed/route.ts`; `app/api/agents/learner/route.ts`.
Reversal cost: Low

### Decision 12: Auto-embed cron before the weekly learner run

Date: 2026-07-03
Status: Approved
Category: Architecture

Context: Semantic search is only useful if new enriched decisions get embedded before the learner needs them.
Decision: Run the embed route on a weekday 4:50 PM scheduled task (`Kairos\embed`), ahead of the Friday 5:00 PM learner. Candidate selection uses a `unembedded_trade_decisions` NOT-EXISTS RPC (bounded, deterministic) rather than loading all embedded ids into app memory. The learner tolerates missing embeddings (tool returns an error, agent continues).
Reason: Keeps the vector store fresh with no manual step; NOT-EXISTS scales past the in-memory-id approach; the 10-minute gap plus small daily volume makes overlap a non-issue.
Alternatives considered: Embed inline during enrichment (couples two concerns); load-all-ids-then-filter-in-JS (unbounded memory as history grows); no automation (stale vectors).
Impact: Adds an `embed` agent to `run-agents.ps1` and a scheduled task; `run-agents.ps1` now resolves `CRON_SECRET` at runtime from `.env.local` (secret never committed).
Files/features affected: `scripts/run-agents.ps1`, `scripts/register-tasks.ps1`, `supabase/migrations/047_*`.
Reversal cost: Low

### Decision 13: Challenger lifecycle for learner weight changes

Date: 2026-07-03
Status: Approved
Category: Architecture / Security

Context: LearnerAgent previously mutated `signal_weights` directly, letting probabilistic reasoning silently overwrite the live champion strategy — violating the governance principle in Decision 4.
Decision: `update_signal_weight` no longer touches `signal_weights`. It inserts an immutable `strategy_versions` row with `state='challenger'` and a `weights_snapshot` (only the five weight columns, no metadata). Weights take effect only when a human promotes the challenger to champion via the Strategy Registry. Every Supabase error is checked; success is reported only after a confirmed insert; versions carry a date+HHMMSS suffix to avoid same-day collisions.
Reason: Human-in-the-loop gate before any strategy change goes live; auditable proposal trail; no silent authority expansion.
Alternatives considered: Direct weight mutation (unsafe); auto-promote above a confidence threshold (removes human gate).
Impact: Learner output is advisory until promoted; adds challenger rows to `strategy_versions`.
Files/features affected: `app/api/agents/learner/route.ts`, Strategy Registry UI.
Reversal cost: Low

### Decision 14: LearnerAgent runs on DeepSeek-reasoner, not Opus (no ANTHROPIC_API_KEY)

Date: 2026-07-04
Status: Approved
Category: Technical / Architecture

Context: LearnerAgent was configured for `claude-opus-4-8`, but the app has no raw `ANTHROPIC_API_KEY` — all Claude usage falls back to the `claude` CLI subprocess (`execClaude`), which cannot do tool-calling. Every Friday the learner's tool-loop threw "Could not resolve authentication method" and recorded a 0-token error run.
Decision: Run the learner on `deepseek-reasoner` (works via DeepSeek's native tool-calling, ~$0.043/run). `runAgentLoop` dispatches by model prefix: Claude → Anthropic SDK tool loop, everything else → DeepSeek. The Claude branch stays in code but requires a real `ANTHROPIC_API_KEY` to ever run.
Reason: The learner must actually run; DeepSeek-reasoner gives budget-friendly step-by-step reasoning today. Model is user-changeable per agent via `/dashboard/agents` → LLM Config (`agent_config.model`).
Alternatives considered: Keep Opus + add `ANTHROPIC_API_KEY` (best reasoning, real API cost $5/$25 per Mtok — deferred until the user adds a key); `deepseek-chat` (cheaper, weaker reasoning). Supersedes the earlier "Opus for learner" intent.
Impact: Learner reasoning quality is DeepSeek-reasoner tier, not Opus, until an Anthropic key is added.
Files/features affected: `agent_config.model` (learner), `lib/llm-router.ts`.
Reversal cost: Low

### Decision 15: Langfuse observability + full agent-loop cost logging

Date: 2026-07-04
Status: Approved
Category: Technical / Data

Context: Direct `callLLM` calls were logged to `llm_call_log`, but agent tool-loops (learner/research/mentor/theme-scout/macro-sentinel via `runAgentLoop`) bypassed it — so the cost dashboard undercounted exactly where the expensive tokens live. There was also no external trace view of LLM calls.
Decision: (a) `runAgentLoop` now calls `logCall` on every invocation (model, tokens, cost, duration, success, `agent_label`, `run_id`), so all agent-loop usage appears at `/dashboard/admin/llm-history`. (b) `callLLM` wraps each call in a Langfuse trace/generation, gated on `LANGFUSE_SECRET_KEY`/`LANGFUSE_PUBLIC_KEY` and no-op when absent.
Reason: Accurate per-agent/per-task cost visibility is required to make model-tier decisions with data; Langfuse adds zero-risk external tracing when keys are present.
Alternatives considered: Leave agent loops untracked (blind spot); build a custom trace UI (reinventing Langfuse).
Impact: Complete cost ledger; optional Langfuse tracing.
Files/features affected: `lib/llm-router.ts`, `llm_call_log`, `/dashboard/admin/llm-history`.
Reversal cost: Low

### Decision 16: Deep-Dive Debate — adversarial per-symbol analysis

Date: 2026-07-04
Status: Approved
Category: Product / Architecture

Context: Competitor trading-agents.ai produces an argued per-symbol verdict via multi-agent debate; Kairos only produced a numeric analyst_score.
Decision: On-demand per-symbol Deep-Dive: 4 parallel analysts → Bull vs Bear advocate → Research Evaluator → Risk desk → Portfolio Manager verdict (BUY/HOLD/SELL/PASS + conviction). Reasons over data we already have (quote + our signal scores + macro + 1 Alpha Vantage OVERVIEW for fundamentals) to stay in AV's 25/day budget. DeepSeek models (no ANTHROPIC_API_KEY). Long-only enforced (unheld → BUY/PASS). Advisory only — risk gate still governs. Stored in `deep_analyses`.
Reason: Closes the one gap where the competitor was ahead (argued verdict + transparency) without giving up governance.
Alternatives considered: Full history re-read (expensive); replace analyst_score (loses the deterministic pipeline).
Impact: New per-symbol "Deep Dive" tab; ~$0.004/run.
Files/features affected: `app/api/agents/deep-dive/`, `components/dashboard/DeepDivePanel.tsx`, migration 048.
Reversal cost: Low

### Decision 17: MentorAgent is a true AI coaching agent

Date: 2026-07-04
Status: Approved
Category: Product / Architecture

Context: The old mentor just scored a single thesis. The user wants a coach that reasons over their behavior + market + learning progress.
Decision: MentorAgent is a deepseek-reasoner tool-use agent (query_behavior, query_learning_progress, query_market_context, read_principles → finish). Returns grade + confidence, strengths, focus areas, one market-tailored lesson, next milestone. Grounded; if data is thin it coaches on process. Advisory/educational only. Stored in `mentor_insights`, surfaced on the Mentor "AI Coach" tab + the briefing. Weekly cron (Fri 5:15 PM).
Reason: A data-grounded personal trading coach is a differentiator nobody combines (behavior + regime + curriculum).
Alternatives considered: Keep the one-shot scorer; a human-written static tip.
Impact: New coaching surface; ~$0.006/run.
Files/features affected: `app/api/agents/mentor-coach/`, `components/dashboard/MentorCoachPanel.tsx`, migration 050.
Reversal cost: Low

### Decision 18: Briefing = structured data blocks + short LLM note (newsletter-grade)

Date: 2026-07-04
Status: Approved
Category: Product / UX

Context: The briefing was a wall of LLM prose. The user wants newsletter-grade structure with mandatory explanations on every metric.
Decision: Render the data deterministically as designed HTML blocks (accurate); the LLM writes only a short editor's note + a grounded 3-part outlook with confidence. v2 adds a lighter theme, per-metric explanations, market/positions/future outlooks, a 7-day agent-activity recap, and a Mentor block. Email delivers via Resend; `email_sent` reflects the real result; recipient/sender overridable via `BRIEFING_TO`/`BRIEFING_FROM`. onboarding@resend.dev only delivers to the Resend account owner until a domain is verified.
Reason: Numbers must be accurate (code-built) and every figure must carry a what/why (locked user preference — details mandatory).
Alternatives considered: All-LLM prose (hallucination + wall of text); all-static (no human voice).
Impact: Redesigned morning/evening emails.
Files/features affected: `app/api/briefing/generate/route.ts`.
Reversal cost: Low

### Decision 19: Markets synthesis from ETF regime proxies (no AV budget)

Date: 2026-07-04
Status: Approved
Category: Architecture / Data

Context: The user wants a synthesis above the heatmap answering "where are markets and heading" from more than just VIX.
Decision: A Market Synthesis card reads ETF regime proxies via Massive (breadth SPY/QQQ/IWM, credit HYG/IEF, rates TLT/IEF, dollar UUP, gold GLD, vol VIXY), computes risk-on/neutral/risk-off, and a DeepSeek synthesis grounded only in those numbers, with a what/why note on every tile. Sector Breadth gains a 1W–1Y period selector. Uses Massive (not Alpha Vantage) to avoid the 25/day cap.
Reason: A combined-signal read guides the user and feeds regime context; ETF proxies via Massive are budget-free.
Alternatives considered: Alpha Vantage macro series (blows the 25/day budget).
Impact: New synthesis section on Markets; cached to `briefings` (session='synthesis', migration 038).
Files/features affected: `app/api/markets/synthesis/`, `components/dashboard/MarketsPage.tsx`, `SectorBreadth.tsx`.
Reversal cost: Low

### Decision 20: Automation schedule source-of-truth + nav consolidation

Date: 2026-07-04
Status: Approved
Category: Architecture / UX

Context: The pipeline widget was hardcoded/wrong; there was no single view of what runs when/where. Nav had duplicated/overlapping items.
Decision: `lib/schedule.ts` is the single source-of-truth for all 12 scheduled jobs (name, time, days, runner, description, handoff). A read-only Settings → Automation page shows times, runner (Windows Task Scheduler), last/next run. Consolidated nav: removed the duplicate Intelligence "brief" tab (#11), unified Strategies + Algo Library into one tabbed section and dropped the standalone Library nav item (#18/#19). All crons run via Windows Task Scheduler (cloud edge-function crons decommissioned); edit by re-running `scripts/register-tasks.ps1`.
Reason: One accurate schedule surface; less nav clutter; honest about what's editable where.
Alternatives considered: Keep hardcoded widget; in-app schedule editing (needs OS/admin — deferred).
Impact: New Automation page; leaner nav.
Files/features affected: `lib/schedule.ts`, `app/dashboard/settings/automation/`, `app/api/automation/schedule/`, `DashboardShell.tsx`, `scripts/*.ps1`.
Reversal cost: Low

### Decision 21: Sector chart — real TradingView widget, not a custom Massive-backed chart

Date: 2026-07-04
Status: Approved
Category: Architecture / Data

Context: The Sector Correlation chart on Markets was custom-built against Massive candle data. Root-caused a missing pagination bug (`next_url` wasn't followed, so 1Y+ periods silently returned the same truncated data as 3M — commit `bc07c7a`). Fixing pagination then exposed a real provider limit, not a code bug: Massive's free tier hard-caps every aggs response at ~500 bars with no pagination beyond that (confirmed via direct API call requesting 2016–2026 and getting back only the most recent ~500 bars).
Decision: Replace the custom Massive-backed sector chart entirely with TradingView's real widget. First tried the free "Symbol Overview" embed (`77f371f`) — it did not hydrate reliably in real testing (empty section on the Markets page). Landed on reusing the same `TradingViewChart` component (real tv.js Advanced Chart widget — full toolbar, indicators, real period buttons) already proven on the symbol detail page, with a tab switcher across the 11 sector ETFs, since TradingView's free tier has no combined multi-symbol overlay/correlation chart (`9f81fd5`).
Reason: Massive's free tier cannot support long-lookback sector correlation no matter how the code is written; TradingView's real widget gives accurate, full-history charting per sector today without waiting on a paid Massive plan.
Alternatives considered: Upgrade Massive plan (cost, deferred); keep the custom chart capped at ~2yr lookback for 3Y/5Y/10Y (misleading — those periods would silently show the same window); free "Symbol Overview" embed (tried first, didn't render reliably).
Impact: Sector Correlation section on Markets is now single-symbol-at-a-time (tab per sector ETF) rather than a combined overlay chart, in exchange for accurate, full-toolbar real-time charting per sector.
Files/features affected: `components/charts/SectorTradingViewOverview.tsx` (new); removed `components/charts/SectorLineChart.tsx` and `app/api/charts/sector-history/route.ts`.
Reversal cost: Low (additive — a combined overlay could be reintroduced later on a paid Massive tier or a different data provider)

### Decision 22: Privacy Mode — mask live-account dollar figures by default

Date: 2026-07-04
Status: Approved
Category: Product / UX

Context: Live Robinhood account figures (equity, buying power, position values, P&L) render in plaintext on Dashboard home and Live Portfolio — a problem for screen-sharing, screenshots, or anyone glancing at the screen.
Decision: An eye-icon toggle on both surfaces masks these figures by default; clicking reveals them. The reveal state is plain `useState`, not persisted, so it resets to hidden on every navigation away and back — no extra logic needed to "re-hide." A master on/off switch lives in Settings → Preferences, persisted to `localStorage` (`components/dashboard/PrivacyMask.tsx`).
Reason: Default-hidden is the safer default for a dashboard that's frequently open during screen-shares; per-mount reset means the user never has to remember to re-hide; a master switch lets users who don't need this (private single-user desktop) turn it off entirely.
Alternatives considered: Persist the reveal state across navigation (risk of numbers staying visible after the user forgets); no default masking (status quo, rejected as the motivating problem); server-side masking (unnecessary — this is a display-only concern with no security boundary implication).
Impact: New shared component; two consuming surfaces (Dashboard home "Live Robinhood" panel, Live Portfolio page).
Files/features affected: `components/dashboard/PrivacyMask.tsx` (new), `components/dashboard/DashboardHome.tsx`, `components/dashboard/LivePortfolioPage.tsx`, `app/dashboard/settings/page.tsx`.
Reversal cost: Low

### Decision 23: execClaude/MCP tool-calling gap — OPEN, decision needed, not yet resolved

Date: 2026-07-04
Status: **Open — not resolved. Requires explicit user sign-off before any fix.**
Category: Architecture / Security

Context: An audit this session found that `execClaude` (`lib/claude-exec.ts`) runs the Claude Code CLI as a plain text-completion subprocess — no `ANTHROPIC_API_KEY`, no MCP server config attached anywhere. It structurally cannot call any MCP tool (Robinhood, FinancialDatasets, etc.) no matter what its prompt asks for; the pattern in every call site is "ask the model to call a tool it can't reach, trust whatever text comes back." Confirmed call sites: `lib/research-agent.ts` (`fetchAndStoreAccountSnapshot` and `runScreener` — meaning the CLAUDE.md-mandated dual-bucket momentum/value screener has likely never produced real candidates via this path), `app/api/mentor/evaluate/route.ts` (worst case: could silently write hallucinated "verified" fundamental data into `trade_journal` as fact), `app/api/portfolio/live-holdings/route.ts`, `lib/market-data.ts`, `app/api/portfolio/robinhood/route.ts`, `lib/chart-data.ts` (two functions), and — highest severity — `app/api/agents/trader/route.ts` and `app/api/agents/trade/approve/route.ts`, the real-money order-execution paths for account `605420660`, which gate "order submitted to Robinhood" entirely on a `success: true` JSON flag `execClaude` cannot authentically produce. It currently fails toward `success: false` in practice rather than fabricating a fill, but this is not a code guarantee — there is no independent verification step.
Decision: **Not resolved.** This entry exists to flag the risk and lock in why `trading_mode = disabled` must stay in place (per CLAUDE.md) until a real fix ships. No code change has been made against this finding.
Reason: This is exactly the class of risk Decision 3 (Evidence, Data, and Online Research Policy) was written to prevent — LLM-mediated "tool calls" that aren't real must not be trusted as evidence or as execution confirmation, especially on the order-placement path.
Alternatives considered (proposed, none implemented yet): (a) Rebuild these call sites as direct, typed API calls with no LLM asked to "call" a tool in the loop — most consistent with Decision 3; (b) add a real `ANTHROPIC_API_KEY` so `execClaude`'s replacement can use genuine MCP tool-calling; (c) leave as-is and rely on `trading_mode = disabled` — acceptable short-term only, not a fix.
Impact: Until resolved, do not enable live trading; do not trust `research-agent.ts`'s screener output as verified against real MCP data; treat `mentor/evaluate` "verified" fundamentals with suspicion.
Files/features affected: `lib/claude-exec.ts`, `lib/research-agent.ts`, `app/api/mentor/evaluate/route.ts`, `app/api/portfolio/live-holdings/route.ts`, `lib/market-data.ts`, `app/api/portfolio/robinhood/route.ts`, `lib/chart-data.ts`, `app/api/agents/trader/route.ts`, `app/api/agents/trade/approve/route.ts`.
Reversal cost: N/A (nothing reversed — decision on the fix approach is pending)

### Decision 24: Close the learning loop — ResearchAgent consumes promoted champion weights

Date: 2026-07-05
Status: Approved
Category: Architecture / Data

Context: Decision 13 established the challenger→champion governance path: LearnerAgent proposes weight challengers into `strategy_versions`, and a human promotes one to champion (`is_champion=true`, `weights_snapshot` jsonb). But the loop was OPEN — nothing downstream ever read the promoted weights. ResearchAgent scored every symbol with a hardcoded `PROFILE_WEIGHTS` table keyed only on `risk_profile`, and `signal_weights` was dead code. Approved learning had zero effect on scoring.
Decision: `lib/research-agent.ts`'s `processSymbol` reads the promoted champion's `weights_snapshot` first, normalizing both key formats (seed row short keys `{fundamental:0.3,...}`; LearnerAgent challenger suffixed keys `{fundamental_weight:0.3,...}`). It falls back to the static `PROFILE_WEIGHTS` table (then `signal_weights`) only when no champion is promoted. `research_packets.raw_data` records `_using_champion_weights: true/false` per signal for auditability.
Reason: A learning system that can't affect scoring is decorative. This is the hop that makes the human-gated challenger path from Decision 13 actually change production behavior — while keeping the human promotion gate intact.
Alternatives considered: Auto-apply challenger weights without promotion (removes the Decision 13 human gate — rejected); keep scoring on `PROFILE_WEIGHTS` and treat learning as advisory-only forever (defeats the learner's purpose).
Impact: Promoting a challenger now changes ResearchAgent's next-run scoring. No effect until a champion is actually promoted (falls back to profile weights).
Files/features affected: `lib/research-agent.ts` (`processSymbol`), `strategy_versions`, `research_packets.raw_data`.
Reversal cost: Low (revert to always reading `PROFILE_WEIGHTS`)

### Decision 25: Durable per-symbol score history (`signal_score_history`) + ScoreTrajectory feature

Date: 2026-07-05
Status: Approved
Category: Data / Product

Context: PRD.md specced a "30-day price + agent score history" chart, but the data model never existed. `agent_signals` rows get status-mutated and filtered, and the table barely accumulates, so the existing ScoreTrajectory chart UI was starved of data. There was no durable record of how a symbol's score evolved over time.
Decision: New append-only table `signal_score_history` (migration 054): `symbol`, `analyst_score` + 5 dimension scores (`fundamental`/`technical`/`sentiment`/`macro`/`insider`), `direction`, `source`, `created_at`; RLS service_role-all + authenticated-read; index on `(symbol, created_at desc)`. Every score computation in `lib/research-agent.ts` appends a row (best-effort — won't fail the research run, no-ops until migration applied). Rows are never touched after insert. Consumed by (1) a `SCORE TREND` note injected into the thesis prompt so the agent reasons about conviction momentum, and (2) a new `GET /api/charts/score-history?symbol=X` route feeding the symbol-detail ScoreTrajectory chart.
Reason: Score trajectory is signal — a rising score carries different conviction than a cold snapshot at the same value. An append-only history is the honest data model (unlike the mutated `agent_signals`) and finally delivers the PRD chart.
Alternatives considered: Reconstruct history from `agent_signals` (unreliable — rows are mutated/filtered); store history inside `research_packets.raw_data` (not queryable per-symbol over time).
Impact: New table + route; thesis prompt gains a trend line; symbol detail page chart now shows real durable history. Best-effort write means research runs are unaffected if the insert fails.
Files/features affected: `supabase/migrations/054_signal_score_history.sql`, `lib/research-agent.ts`, `app/api/charts/score-history/route.ts`, symbol detail ScoreTrajectory chart.
Reversal cost: Low

### Decision 26: LearnerAgent Phase B is a last-resort backstop, deferring to the Phase A smart-exit path

Date: 2026-07-05
Status: Approved
Category: Architecture

Context: The LearnerAgent had two exit mechanisms that raced. Phase A (smart) re-scores a position's current signal and flags `exit_reason="llm_exit"`, which position-monitor executes with a live price + trailing-stop logic. Phase B (blunt) unconditionally closed any `paper_trades` row >7 days old on a crude `pnl>$0.50` win/loss threshold. The same position could be closed by both in one run, and the crude outcome usually won — overriding the smart exit.
Decision: Phase B now (1) skips any trade whose position already carries the `llm_exit` flag — deferring to Phase A / position-monitor — and (2) its time cutoff moves from 7 → 14 days, making it a true last-resort backstop (nothing sits open forever) rather than a primary exit competing with the smart path.
Reason: The smart, live-priced exit should always win; the blunt time-based rule exists only to guarantee nothing is stranded open indefinitely. De-conflicting them prevents the crude outcome from silently clobbering the intended exit.
Alternatives considered: Remove Phase B entirely (loses the guarantee that stale positions eventually close); keep both racing (status quo — crude path wins incorrectly).
Impact: Phase A drives real exits; Phase B only touches positions with no `llm_exit` flag that are >14 days old.
Files/features affected: `app/api/agents/learner/route.ts` (Phase A / Phase B close logic).
Reversal cost: Low

### Decision 27: Langfuse tracing extended to the agent tool-loop (`runAgentLoop`)

Date: 2026-07-05
Status: Approved
Category: Technical / Data

Context: Decision 15 wrapped single-shot `callLLM` completions (thesis, screening, chat) in Langfuse traces. But the multi-step tool-calling `runAgentLoop` (LearnerAgent, MentorAgent) was invisible in Langfuse — it only wrote to the internal `llm_call_log` table. The most complex, multi-turn LLM usage had no external trace view.
Decision: Wrap `runAgentLoop` in a Langfuse trace/generation span capturing system prompt in, final text out, total tokens, cost, and the tool-call trail as metadata. Gated on the Langfuse keys and no-op when absent, consistent with Decision 15.
Reason: The tool-loops are exactly where multi-turn debugging and cost attribution matter most; leaving them out of Langfuse was the biggest remaining observability gap.
Alternatives considered: Leave agent loops traced only in `llm_call_log` (no span/tool-call view); adopt LangChain/LangGraph for built-in tracing (rejected — the loop stays hand-rolled against the Anthropic/DeepSeek SDKs; not introducing a framework just for tracing).
Impact: Agent tool-loops appear as Langfuse traces with their tool-call trail; no change to agent logic. LangChain/LangGraph remain unused.
Files/features affected: `runAgentLoop` (agent tool-calling loop), Langfuse integration in the LLM layer.
Reversal cost: Low

### Decision 28: India market data via free Yahoo Finance (not a paid feed)

Date: 2026-07-05
Status: Approved
Category: Data / Architecture

Context: Kairos added India as a second market. Execution runs through Zerodha Kite, but the Kite **Personal tier provides execution + portfolio only, with no market data**. Indian NSE stocks still need price, candles, and fundamentals to run the same 5-dimension scoring pipeline as US stocks.
Decision: Source all India market data from **free Yahoo Finance** (`.NS` symbols). `lib/india-data.ts` uses the Yahoo chart endpoint for price + candles (unauthenticated) and a cookie+crumb `quoteSummary` call for fundamentals (P/E, ROE, margins), remapping the result into the exact AV-OVERVIEW shape the existing scorer already consumes. Candidates come from a static NIFTY-50 list (`lib/india-universe.ts`) rather than a paid screener. US-only inputs (social sentiment, options, insider) are unavailable for India, so those dimensions use a neutral baseline, flagged honestly in the score-detail.
Reason: Kite Personal tier has no data feed; paying for one (or upgrading Kite) is unjustified when Yahoo covers price, candles, and core fundamentals for free. Mapping into the AV-OVERVIEW shape lets India reuse the whole scoring pipeline with no scorer changes.
Alternatives considered: Pay for a Kite data subscription or a third-party Indian data vendor (cost, deferred); a paid screener for candidate selection (static NIFTY-50 is sufficient for now); skip India fundamentals entirely (loses the fundamental dimension).
Impact: India scores on free data with no per-call cost; the three US-only dimensions are neutral for Indian names by design. No direct non-US equity coverage exists beyond India.
Files/features affected: `lib/india-data.ts`, `lib/india-universe.ts`, `lib/research-agent.ts`, paper-trade route (India exclusion — see Decision 29).
Reversal cost: Low (data adapter is replaceable; the AV-OVERVIEW mapping isolates the scorer from the source)

### Decision 29: India is scored + tracked but NOT paper-traded (currency/USD-pool)

Date: 2026-07-05
Status: Approved
Category: Product / Data / Architecture

Context: US signals flow into a single `paper_portfolio` USD pool for paper P&L before any real money is involved. India was added as a second market, and the question was whether Indian signals should also open paper positions.
Decision: India is **scored and tracked** (Score Tracker, `/dashboard/india`) but **NOT paper-traded**. `PaperTrader` excludes `asset_class = "india"`. Indian stocks are acted on via **real Zerodha Kite orders** instead (see Decision 30).
Reason: The `paper_portfolio` is a single USD pool; Indian stocks are INR-priced. Mixing currencies into one NAV pool would corrupt paper P&L and NAV/alpha accounting. Keeping India out of the paper pool preserves the integrity of the USD paper track while still surfacing India's scores.
Alternatives considered: Convert INR fills to USD at a daily FX rate for the paper pool (adds an FX-rate dependency and silent conversion error into every India paper P&L — rejected); a separate INR paper pool (new parallel accounting surface, deferred — India already executes for real via Kite so a paper stage adds little); score India but hide it (loses the Score Tracker value).
Impact: India appears in scoring/tracking surfaces but never in paper positions or paper NAV. The US "paper-first" path and the India "real-only via Kite" path are deliberately asymmetric.
Files/features affected: `lib/research-agent.ts`, paper-trade route, `/dashboard/india`, Score Tracker.
Reversal cost: Low (a separate INR paper pool could be added later without touching the USD pool)

### Decision 30: Zerodha Kite for India execution — human-confirm + daily one-click token

Date: 2026-07-05
Status: Approved
Category: Security / Architecture / Product

Context: India needs real order placement and holdings (there is no paper stage — Decision 29). Zerodha Kite Connect v3 is the broker. Kite access tokens expire at 6 AM the next day by SEBI rule and cannot be silently refreshed without storing broker credentials.
Decision: Real Kite execution (`app/api/kite/order` — `POST /orders/regular`, product `CNC`) and holdings read (`app/api/kite/portfolio`) with a strict human-in-the-loop model: **authenticated-user-only (never cron/agent), requires explicit `confirm: true`, writes a `decision_journal` audit row**, and the `/dashboard/india` UI uses a two-step confirm with a prominent "REAL MONEY" warning that never fires on first click. Auth is a **daily one-click Kite Connect v3 login** (`lib/kite.ts`, `app/api/kite/login|callback|status`): login → `request_token` → SHA256-checksum exchange → `access_token` stored in `api_key_vault` as `KITE_ACCESS_TOKEN`, treated as expired if not generated today. Reads and orders degrade to a "reconnect" state when the token is stale.
Reason: India orders are real money with no paper buffer, so the confirm gate must be stricter than the US path — never agent-invoked, always explicit two-step confirm, always audited. The daily re-login is a SEBI regulatory constraint; automating it would require storing broker credentials, which is deliberately not done.
Alternatives considered: Allow cron/agent-placed India orders (rejected — real money, no paper stage, unacceptable without a human); store broker credentials to auto-refresh the token (rejected — deliberately not storing credentials); a paper stage before real Kite orders (Decision 29 — INR/USD pool conflict).
Impact: India execution requires a fresh one-click login each trading morning and an explicit two-step "REAL MONEY" confirm per order. No automated India trading path exists.
Files/features affected: `lib/kite.ts`, `app/api/kite/login`, `app/api/kite/callback`, `app/api/kite/status`, `app/api/kite/portfolio`, `app/api/kite/order`, `app/dashboard/india`, `api_key_vault` (`KITE_ACCESS_TOKEN`), `decision_journal`, Settings → Agents connection card.
Reversal cost: Medium (execution path is broker-specific; auth/token model is Kite/SEBI-specific)

### Decision 31: Multi-market via per-currency paper pools + per-market champion weights (market as a tag, not a fork)

Date: 2026-07-05
Status: Approved
Category: Architecture / Data / Product

Context: India was scored + tracked but NOT paper-traded (Decision 29) because the single USD `paper_portfolio` pool could not absorb INR fills without corrupting NAV. The cost of that decision: India produced **zero closed paper outcomes**, so the Learner/Mentor never learned it — the learning loop was open for India. Meanwhile "market" was drifting toward a fork (US-only paths vs India-only paths), and `market_focus` still offered Europe/Asia/Crypto/Global regions that were never real markets.
Decision: Make **market a tag/dimension (us | india), not a fork** — one app, panels filter by market, currencies are NEVER summed into one number. (a) **Separate per-currency paper pools:** each market gets its own pool in its own currency — US = existing USD pool ($10k), India = new ₹ pool (₹1,000,000 starting cash). `paper_portfolio`/`paper_positions`/`paper_trades`/`paper_performance`/`agent_signals`/`signal_score_history` all gain a `market` column; `paper_performance` unique key moves from `(date)` to `(date, market)` so each market keeps its own NAV curve. PaperTrader fills each signal into its market's pool in native currency off the right price source (US via `getQuote`; India via free Yahoo `.NS`), sizing on THAT pool's cash. PositionMonitor monitors/exits per market in native currency, crediting each close back to its own pool. This **closes the learning loop for India** (it now produces closed outcomes). (b) **Per-market champion weights:** `strategy_versions` gains a `market` column; LearnerAgent analyzes ONE market's cohort per run and proposes challengers ONLY for that market's champion, so a bad India run can never shift US scoring. India starts on a CLONE of the US champion as a prior (seeded by 057) and diverges once it clears the same 10+ closed-trade phase gate. ResearchAgent reads the market-matched champion. (c) **`market_focus` trimmed to US + India only** (Europe/Asia/Crypto/Global removed as noise) and is a **non-destructive gate:** turning India ON starts NIFTY scoring + ₹ paper fills + India learning cohort; turning it OFF stops NEW India research/fills but KEEPS open India positions monitored-to-close plus all history/weights (re-enable resumes). Real Kite holdings/execution are unaffected by the toggle (real money, independent of a preference). (d) **Guarded/resilient rollout:** pre-057 (no `market` column, single pool) every path behaves byte-for-byte as the old US-only app; India activates automatically once 057 is applied and the pool row exists.
Reason: Per-currency pools let India paper-trade without ever blending INR into the USD NAV — which fixes the exact corruption Decision 29 avoided, but now WITH a closed learning loop. Per-market champions keep cross-country learning from contaminating each other. Market-as-tag keeps it one app instead of a maintenance-doubling fork. A non-destructive gate means toggling a market is a preference, not a data-loss event. Supersedes Decision 29 (India IS now paper-traded, in its own INR pool).
Alternatives considered: Keep India score-only forever (Decision 29 — leaves the India learning loop permanently open, rejected); one shared pool with daily FX conversion of INR fills to USD (silent conversion error in every India P&L — rejected, same reason as Decision 29); a single global champion across markets (a bad India cohort would shift US scoring — rejected); fork the app into US and India builds (doubles maintenance surface — rejected).
Impact: India now paper-trades in ₹ and feeds the Learner/Mentor; US and India each keep an independent NAV curve and champion. No cross-market contamination. No change to the US path until India is enabled. **Migration 057 could NOT be auto-applied this session (Supabase MCP permission-denied, no psql/DATABASE_URL) — the user must apply `057_multi_market.sql` manually in the Supabase SQL editor before India activates. Guarded code means the app runs unchanged until then.**
Files/features affected: `supabase/migrations/057_multi_market.sql`, `app/api/agents/paper-trade/route.ts`, `app/api/agents/position-monitor/route.ts`, `app/api/agents/learner/route.ts`, `lib/research-agent.ts`, Settings `market_focus`, portfolio UI market selector, `strategy_versions`/`paper_*`/`agent_signals`/`signal_score_history` (new `market` column), `public/agent-diagrams/system-map.json`.
Reversal cost: Medium (schema-coupled — a `market` column across six tables and a changed unique key; guarded code de-risks rollback)

### Decision 32: Full India feature parity via a market-scoped panel architecture + direct NSE feeds (with graceful Yahoo/NIFTY-100 fallback)

Date: 2026-07-05
Status: Approved
Category: Architecture / Product / Data

Context: Decision 31 made India a paper-trading, self-learning market with its own ₹ pool and champion, but India was still second-class across the UI — most panels were US-only, and the two free-data ceilings from Phase 2 remained: the India scanner could only see NIFTY-100 (no full-market scan) and insider/option data was US-only. The question was how to bring India to parity across every dashboard panel without forking the app, and how to lift those two ceilings without paying for a data feed.
Decision: Ship "India parity" as a market-scoped panel architecture plus direct NSE feeds. (a) **Market-as-context switcher:** `lib/market-context.tsx` (`MarketProvider`/`useMarket()`) holds the selected market (`us | india`), persisted to `localStorage` + an `mkt` cookie; rendered in the `DashboardShell` header but **hidden unless `market_focus` includes India**. Client panels scope to the selected market; server pages read the `mkt` cookie. (b) **Honest per-page support badges:** `lib/market-support.ts` is the single source of truth mapping each route → `{level: full|partial|us-only|india-only, note}`, rendered as a footer badge on every dashboard page — flip a level there as a panel gains coverage. Panels wired for India (US path unchanged, India via free data): Markets (NIFTY/SENSEX/BankNifty/India-VIX via Yahoo), Risk Analytics (per-₹ book, VaR vs NIFTY; beta-vs-NIFTY still coming soon), Backtest (Yahoo `.NS` candles, alpha vs NIFTY), Scanner (full NSE via nightly cache, NIFTY-100 fallback), Strategies (market-scoped fit scores; India classification still US-only), Earnings (India per-symbol dates via Yahoo, tracked names only), Smart Money (signals + trade queue both markets; India insider + option PCR/OI live from NSE). (c) **NSE-direct to lift the free-data ceilings:** `lib/nse-data.ts` is a cookie-handshake adapter for NSE's free JSON — full equity list (`EQUITY_L.csv`), insider (`corporates-pit`), option chain (`option-chain-indices`/`option-chain-equities`) — which lifted the two ceilings (full-market scan + India insider/options). It fails soft: callers fall back to Yahoo / NIFTY-100 with an honest note. (d) **Cache for the full-market scan:** migration `058_india_screen_cache.sql` (new table) + nightly cron `POST /api/scan/india/refresh` scores the full NSE list in 600-name oldest-first slices; the Scanner reads the cache and falls back to live NIFTY-100. (e) **Per-market crons:** `research`/`paper-trade`/`position-monitor` accept `?market=us|india`; the US 9 AM tasks are pinned to `?market=us` so they no longer double-process India, and India runs its own Task Scheduler tasks (PC clock = ET, all post-NSE-close): scan-india-refresh 5:30 AM, research-india 6:15 AM, position-monitor-india 6:35 AM.
Reason: A market-scoped panel architecture brings India to full parity while keeping one app (no fork, no maintenance doubling); the support registry keeps the UI honest about exactly where India is full vs partial vs US-only. NSE-direct feeds lift the two remaining ceilings for free, and failing soft to Yahoo/NIFTY-100 means a geo-blocked NSE never breaks a page. The cache makes a full-market NSE scan affordable to run nightly. Per-market crons stop the US schedule from double-processing India.
Alternatives considered: Keep India panels US-only / partial forever (leaves India second-class — rejected); fork the app into US and India builds (doubles maintenance — rejected, consistent with Decision 31's market-as-tag choice); pay for an Indian data vendor for full-market + insider + options (unjustified when NSE's public JSON is free — rejected); hit NSE live on every scanner load (slow + geo-throttle risk — rejected in favor of the nightly cache); one shared cron set for both markets (double-processes India — rejected in favor of `?market=` scoping).
Impact: India reaches parity across the dashboard behind a global switcher; every page shows an honest coverage badge. NSE-direct data powers the full-market scan and India insider/options, degrading gracefully to Yahoo/NIFTY-100 when NSE is geo-blocked (likely from a US IP). New nightly India scan cron + three ET-scheduled India tasks. No change to the US path.
Files/features affected: `lib/market-context.tsx`, `lib/market-support.ts`, `lib/nse-data.ts`, `components/dashboard/DashboardShell.tsx`, Markets/Risk/Backtest/Scanner/Strategies/Earnings/Smart Money panels, `app/api/scan/india/refresh`, `app/api/agents/research/cron` + `paper-trade` + `position-monitor` (`?market=`), `supabase/migrations/058_india_screen_cache.sql`, `scripts/run-agents.ps1`, `scripts/register-tasks.ps1`, `public/agent-diagrams/system-map.json`.
Reversal cost: Medium (schema-coupled — migration 058 + a new cache table and cron; the switcher/support-registry are additive and low-cost to remove, but NSE-direct + per-market crons touch several panels and the schedule)
Update (2026-07-05): The four remaining **partial** India panels were brought to **full** parity — Markets (real sector heatmap + NIFTY-50 breadth via `fetchIndiaSectors`), Risk Analytics (real beta-vs-NIFTY regression), Strategies (real India fit-scores from `signal_score_history`), Earnings (market-wide NSE results calendar via `fetchNseEarnings`, Yahoo per-symbol fallback); `market-support.ts` flipped all four to `full`. Remaining honest US-only bits: Markets TradingView/macro-sentinel tiles, Strategies Algo Library, and NSE feeds may geo-block from a US IP (graceful fallback).

### Decision 33: Point-in-time decision ledger + matured horizon labels (Phase 1 learning-core)

Date: 2026-07-06
Status: Approved
Category: Architecture / Data / Learning

Context: An independent architecture review (Codex, `CODEX_AGENT_REVIEW_RESULT.md`) found the learning plane statistically untrustworthy: LearnerAgent's `query_signals_with_outcomes`/`query_score_correlation` joined signals to closed trades by **symbol** (last-write-wins on repeats), the label was **policy P&L on filled longs only** (selection bias — no signal from rejected candidates), and it mixed alpha with market beta, holding time, and exit policy. Any apparent "learning" could be noise, symbol-collision, or leakage rather than a real edge. This is the single biggest blocker to a genuinely self-evolving agent (see the full roadmap in `features/learning-core/FEATURE_ARCHITECTURE.md`).
Decision: Build an immutable, point-in-time **decision ledger** as the learning ground truth, ahead of any statistical-method work (Phase 2). (a) `decision_observations` (migration 059, append-only via trigger): one row for **every candidate ResearchAgent scores — filled OR rejected** — with the point-in-time raw features (`computeScores().evidence`, free — no scorer refactor), a per-dimension data-availability mask, the weights actually used, the score, and the decision/action. (b) `observation_labels` (migration 060): forward-horizon (2/5/10/20 trading days) outcomes computed **only after horizon maturity** by a nightly cron (`app/api/agents/label-maturation`) — `fwd_return` (cost-haircut adjusted), `benchmark_neutral_return` (SPY for US, NIFTY for India — alpha, not raw P&L), and MAE/MFE (the raw material for future risk-reward sizing). (c) `lib/learning/dataset.ts`: a pure, unit-tested walk-forward dataset builder with purge (drop train rows whose label window overlaps the test window) + embargo (skip a horizon's worth of time after each test window) — no leakage across folds. (d) LearnerAgent's `query_score_correlation` now reads the ledger FIRST (join by `signal_id`, not symbol — a second, standalone bug fixed in the same pass) and falls back to the legacy paper-trades path only while the ledger is thin (<10 rows); results are tagged `source` + an explicit `caveat` that this remains an INTERIM univariate method until Phase 2's validation engine replaces it. (e) The 10-year personal Robinhood trade history tools (`query_trade_decisions`, `semantic_search_decisions`) are explicitly quarantined — tagged `role: "behavioral_evidence_only"` in their return payload and in the system prompt — they may inspire hypotheses but can never satisfy `n_trades` or justify `update_signal_weight`.
Reason: Every later phase (validation engine, calibrated sizing, genome, shadow A/B) optimizes against whatever dataset exists — fixing the dataset first is the only way those phases inherit a trustworthy foundation instead of compounding the existing bias. Capturing the FULL `evidence` blob (not just the 5 scores) costs nothing today and future-proofs Phase 3 feature discovery. No backfill: point-in-time features can't be honestly reconstructed for past signals, so the ledger accrues fresh from deploy — `signal_score_history` is untouched and keeps powering the Score Tracker chart.
Alternatives considered: Fix only the symbol→signal_id join and leave the rest (cheaper, but leaves selection bias and policy-P&L-as-alpha unaddressed — rejected, doesn't reach "statistically trustworthy"); backfill historical signals into the ledger (rejected — can't reconstruct honest point-in-time features after the fact, would silently mix real and reconstructed data); skip the walk-forward purge/embargo (rejected — overlapping swing-return windows would leak future information across folds, defeating the point of the ledger).
Impact: Fully additive and guarded — no change to live trading behavior; the ledger simply accrues (~30-40 rows/day across both markets) until enough matured, horizon-aligned data exists for Phase 2's validation engine. LearnerAgent's correlation tool is immediately more honest (ledger-first, signal_id-joined, benchmark-neutral) even before Phase 2 lands. Migrations 059/060 must be applied manually (Supabase MCP permission-denied this session) before the ledger activates; until then, everything falls back to the pre-existing legacy path unchanged.
Files/features affected: `supabase/migrations/059_decision_observations.sql`, `supabase/migrations/060_observation_labels.sql`, `lib/research-agent.ts` (observation write), `app/api/agents/label-maturation/route.ts` (new), `lib/learning/dataset.ts` (new), `app/api/agents/learner/route.ts` (ledger-first correlation + personal-history quarantine), `scripts/run-agents.ps1`, `scripts/register-tasks.ps1`, `public/agent-diagrams/system-map.json` (LEDGER node).
Reversal cost: Low (two new additive tables + one new cron + a read-path preference in the learner; nothing else depends on the ledger yet)

### Decision 34: Fix long-standing `paper_order_events.signal_id` type bug (bigint → uuid) — every fill event had been silently failing since migration 034

Date: 2026-07-06
Status: Approved
Category: Bug fix / Data integrity

Context: Reconnecting the Supabase MCP (after an earlier session's connector pointed at the wrong account) allowed direct schema introspection for the first time in several sessions. `information_schema.columns` showed `paper_order_events.signal_id` as `bigint` (as originally created in migration 034), while `agent_signals.id` and `paper_trades.signal_id` are both `uuid`. PaperTrader has always inserted `signal_id: signal.id` (a uuid string) into that bigint column — a type mismatch Postgres rejects outright. Live data confirmed the damage: `paper_order_events` had **zero rows, ever**, despite `paper_trades` having historical fills. Every fill's order-event insert was failing, and the paper-trade route's error handling (correctly, per Decision from the earlier Codex-review pass) treated it as a real failure — reverting the signal to `pending` and skipping the fill rather than recording a mis-tagged event. This predates all of this session's work; it is a bug in the original 2026-06 schema, not something introduced by the multi-market/India/learning-core changes.
Decision: Apply `alter table paper_order_events alter column signal_id type uuid using signal_id::text::uuid` directly (migration `070_fix_paper_order_events_signal_id.sql`), applied live via the reconnected Supabase MCP — lossless since the column had zero rows. Also applied migrations `060_observation_labels.sql` and `069_portfolio_limits.sql` (previously blocked by SQL-editor issues) in the same MCP session, and verified the fix end-to-end: restarted the stale `next start` production server (it had been serving a build compiled before several of this session's commits), re-triggered ResearchAgent, and confirmed `decision_observations` now receives real rows with full 5-dimension `features` blobs per candidate.
Reason: A schema-level type bug silently blocking every paper-trade audit-event write for the entire life of the project is a data-integrity issue, not a design question — no alternative considered beyond fixing the type. Doing it via direct MCP access (once available) rather than another round of manual-SQL-editor copy/paste avoided further exposure to the session's earlier Redis/RLS-dialog friction.
Alternatives considered: Leave the column as bigint and stop inserting `signal_id` into `paper_order_events` (rejected — silently drops real audit-trail linkage instead of fixing the root cause); leave it for a future migration batch (rejected — it was actively causing every single paper fill's event log to be empty, worth fixing immediately since the fix was zero-risk with the table empty).
Impact: `paper_order_events` will now actually populate on future fills — the audit trail this table exists for finally works. No behavior change to fills themselves (the JS-side resilience already handled the failure gracefully by reverting to pending; this just makes fills succeed instead of silently retrying forever). Confirms migrations 059/060/069/070 are all live on the FinanceOS Supabase project (`dionkikgdmlaotvtbnfr`).
Files/features affected: `supabase/migrations/070_fix_paper_order_events_signal_id.sql` (new), `paper_order_events` table (live schema change).
Reversal cost: Very low (single column type change on an empty table; trivially revertible)

### Decision 35: Fail-closed Validation Engine + calibrated conviction sizing (Phase 2 learning-core)

Date: 2026-07-06
Status: Approved
Category: Architecture / Learning / Risk

Context: Decision 33 (Phase 1) built the ground-truth decision ledger, but promotion of a LearnerAgent challenger to champion still required only human approval — no objective evidence that the challenger actually outperforms the champion out-of-sample. Similarly, sizing was still a flat `position_size_pct` and R:R a fixed profile percentage, regardless of a signal's actual conviction — the exact "flat bet size on every trade" ceiling identified when auditing risk-reward optimization earlier this session.
Decision: (a) **Validation Engine** (`lib/validation/engine.ts`, migration 061 `validation_experiments`): deterministic, NO LLM. Replays champion vs challenger weights as a scoring-REPLAY against purged/embargoed walk-forward folds from the Phase 1 ledger; a challenger passes only if a 1000-draw moving-block bootstrap (fixed seed 42, reproducible) shows `p_improvement >= 0.80`, the paired-diff confidence interval floor is above a small epsilon, the overlap-adjusted effective sample size is >= 12, and the challenger wins >= 3 of 5 folds. Every run — pass or fail — writes a `validation_experiments` row. (b) **Fail-closed promotion gate**: `promote_champion` (`app/api/strategies/versions/route.ts`) now returns HTTP 412 unless the challenger has a PASSED validation experiment attached; a `force_unvalidated: true` override exists but is journaled as a `governance_override` decision-journal entry, not the default path. (c) **Auto-fire**: LearnerAgent's `update_signal_weight` fires `/api/validation/run` (fire-and-forget) the moment it creates a challenger, so evidence is usually ready before a human even looks at the Strategy Registry; a manual "Validate" button exists on the Agents page too. (d) **Calibrated conviction sizing** (`lib/validation/calibration.ts`, migration 062 `model_artifacts`): a logistic-regression P(win) model (plain gradient descent, no new deps, standardized features, walk-forward calibration curve) replaces the raw uncalibrated `analyst_score` as PaperTrader's sizing input — half-Kelly (`lib/risk/sizing.ts`, built earlier this session) scaled by the ledger's MFE/|MAE| payoff ratio, capped at the existing flat `position_size_pct` as a ceiling. (e) **Dynamic R:R** (`lib/risk/percentiles.ts`): stop/target now come from the ledger's actual MAE/MFE percentile distribution (p25/p75) instead of the fixed 7%/20% profile constants — a signal's own `price_target`/`stop_loss` always wins. All of (d)/(e) are dormant (fall back to the pre-existing flat/fixed behavior) until 60+ matured observations exist per market, refit weekly (Fridays, before the learner).
Reason: Human approval is valuable governance but is not evidence — without a locked evaluation protocol, a persuasive-but-statistically-wrong challenger could become the live scoring policy. Conviction-scaled sizing is what lets the system actually "bet bigger where the edge is real and confident" instead of the same flat size on a barely-qualifying and a max-conviction trade — directly answering the risk-reward-optimization question raised earlier this session. Everything here is deterministic and auditable (fixed seed, stored experiment rows, stored model coefficients) — no LLM makes a sizing or promotion decision.
Alternatives considered: Trust human approval alone (rejected — Codex review's core finding: not evidence); use full Kelly instead of half-Kelly (rejected — ruin risk on a mis-calibrated model); let the Validation Engine auto-promote on pass (rejected — human stays the final live-capital gate per the project's locked design; validation adds evidence, doesn't remove the human); refit calibration continuously instead of weekly (rejected — unnecessary compute for a slow-moving model, weekly matches the learner's cadence).
Impact: A challenger cannot reach champion status without walk-forward evidence (enforced server-side, not just by convention). Paper-trade sizing and stops/targets become conviction- and outcome-distribution-aware once enough ledger data exists — fully dormant and risk-free until then (falls back to today's exact flat/fixed behavior). New weekly cron `fit-calibration` (Fridays 4:45 PM ET, before the 5:00 PM learner).
Files/features affected: `supabase/migrations/061_validation_experiments.sql`, `062_model_artifacts.sql`, `lib/validation/engine.ts`, `lib/validation/calibration.ts`, `lib/risk/percentiles.ts`, `app/api/validation/run/route.ts`, `app/api/validation/fit-calibration/route.ts`, `app/api/strategies/versions/route.ts` (fail-closed gate), `app/api/agents/learner/route.ts` (auto-fire), `app/api/agents/paper-trade/route.ts` (Kelly sizing + dynamic R:R), `components/dashboard/AgentsPage.tsx` (Validate button + pass/fail badge), `scripts/run-agents.ps1` / `register-tasks.ps1`, `public/agent-diagrams/system-map.json` (VALIDATE node, PROMOTE/TRADER updated).
Reversal cost: Low-medium (three new additive tables + a gate on one existing route; the gate can be disabled by reverting the promote_champion check without touching the engine itself)

### Decision 36: Execution Gateway (Alpaca, paper-stage) + fix of a discovered pre-existing Trade Queue bug

Date: 2026-07-06
Status: Approved
Category: Architecture / Execution / Bug fix

Context: Robinhood live trading has always been manual by design (Decision — see REALORDER in system-map: no public order API, so an approved proposal generates a paste-into-Claude-MCP command). This was flagged earlier this session as the one remaining honest gap toward a real "algo execution" platform. While wiring the paper-stage gateway's UI (a "Send to Alpaca" button on Smart Money's Trade Queue tab), a pre-existing bug was discovered: the Trade Queue UI (`app/dashboard/smart-money/page.tsx`) read from a `trade_queue` table (uuid ids, status `pending_approval`), while `/api/agents/trader`'s Approve/Reject actions — and the only table `trade_proposals` inserts real proposal rows into — use `trade_proposals` (bigint ids, status `pending_review`). `handleApprove`'s `parseInt(tradeId, 10)` on a uuid silently produced `NaN`/`null`, so Approve never actually worked against real data. Both tables were confirmed empty in production, so no real approval has ever been lost — this is a latent bug, not a live-data incident.
Decision: (a) Build the Execution Gateway paper-stage: `lib/brokers/alpaca-orders.ts` (submit/get/cancel against Alpaca's REST API, reusing the existing vault-key pattern), migration `068_broker_orders` (typed order lifecycle: pending_submit → submitted/partially_filled → filled/canceled/rejected/error), `app/api/broker/orders` (POST — human-click only, never cron; live env additionally gated on `strategy_config.trading_enabled`), `app/api/broker/orders/sync` (cron, every 30 min market hours — polls Alpaca + reconciles positions, alerts on mismatch). A "Send to Alpaca (paper)" button appears only for `status='approved'` proposals in the Trade Queue history table. (b) Fix the discovered bug in the same change: repointed `app/dashboard/smart-money/page.tsx`'s query from `trade_queue` to `trade_proposals` (aliased columns so the existing UI code needs no further changes), and corrected the `pending`/`decided` split in `SmartMoneyPage.tsx` to check `pending_review` (the real status) instead of `pending_approval`.
Reason: The Gateway's UI needed a working approval flow to attach to — building it on top of the already-broken `trade_queue` read would have shipped a second broken feature. Fixing the underlying table mismatch was the only way to make Approve/Reject AND the new Alpaca button actually functional. This is exactly the kind of thing this session's "if you notice something worth fixing that would bloat the current change, flag it" guidance is for — except it directly blocked correct completion of the task at hand, so it was fixed inline rather than deferred.
Alternatives considered: Build the Alpaca button against the broken `trade_queue` table to match existing (broken) UI code (rejected — would ship a feature that provably cannot work); leave the bug and flag it as a separate follow-up (rejected — the Gateway UI literally cannot be verified without this fix, and both tables being empty made the fix zero-risk); keep Robinhood on the manual path with no typed alternative at all (rejected — this was the explicitly flagged gap toward "algo execution platform").
Impact: Approve/Reject on the Trade Queue tab now actually operate on real data going forward. Paper Alpaca orders can be sent from an approved proposal with one click, tracked through their full lifecycle, and reconciled against Alpaca's own reported positions every 30 min. Live-env orders remain fully gated (trading_enabled + explicit env param) and were NOT tested this session — only the paper path was built and is intended for use; live requires its own explicit go-ahead later. Robinhood's manual path is unchanged (no public API exists to replace it).
Files/features affected: `supabase/migrations/068_broker_orders.sql`, `lib/brokers/alpaca-orders.ts`, `app/api/broker/orders/route.ts`, `app/api/broker/orders/sync/route.ts`, `app/dashboard/smart-money/page.tsx` (table fix), `components/dashboard/SmartMoneyPage.tsx` (status fix + Alpaca button), `scripts/run-agents.ps1` / `register-tasks.ps1`, `public/agent-diagrams/system-map.json` (GATEWAY node, REALORDER updated).
Reversal cost: Low (one new additive table + two new routes; the UI fix is a net bug fix with no downside to reverting since it restores intended-but-never-working behavior)

### Decision 37: Controlled evolution — strategy genome, feature registry, shadow decisions, regime features, governance rewiring (Phase 3 learning-core)

Date: 2026-07-06
Status: Approved
Category: Architecture / Learning

Context: Phases 1–2 gave the learning loop a trustworthy dataset and a fail-closed evidence gate, but the LEARNABLE SURFACE was still only the 5 top-level scoring weights — the exact "reweighting 5 fixed dials can only remix existing assumptions" ceiling the Codex review identified. Nothing could discover a new feature, evolve the entry threshold/horizon/exit policy, or observe a challenger against live opportunities before risking paper capital.
Decision: (a) **Typed strategy genome** (migration 063, `strategy_versions.genome` jsonb + `agent_signals.genome_hash`): a canonical, bounded manifest (entry threshold, horizon, exit family — reusing Phase 2's ledger-percentile stop/target math, sizing mode, universe, regime router) with hard search-domain bounds enforced in code (`lib/validation/genome.ts`), not just documented. Genome-less rows score exactly as before. (b) **Feature registry** (migration 064, `feature_registry`): a new `propose_feature` learner tool stores a machine-readable spec; the formula is NEVER executed as code — only interpreted by a from-scratch whitelisted-grammar tokenizer/parser/evaluator (`lib/validation/feature-compiler.ts`: `+ - * /` and `log/abs/min/max/lag` only, no `eval()`, no dynamic code path). A weekly job (`app/api/validation/feature-check`) computes out-of-sample Spearman rank-IC (Fisher-z significance) across walk-forward folds and promotes `proposed→quarantined→active` on `|IC|>=0.03 & p<0.1` across 2+ of 3 folds, auto-retiring actives whose rolling IC decays below 0.01 for 3 checks. (c) **Shadow decisions** (migration 065, `shadow_decisions`; extends `strategy_versions.state` to allow `shadow_paper`): ResearchAgent records what up to 3 shadow-state versions would decide on every candidate — pure scoring replay, no fills/cash — alongside the champion's real decision. Off by default; a bounded `strategy_config.exploration_enabled` flag (default false) is reserved for future auto-promotion of at most one challenger/week. (d) **Regime features** (`lib/validation/regime.ts`): point-in-time trend (50d-vs-200d MA) and realized-vol tercile vs the market benchmark (SPY/^NSEI), appended to every observation's `features.regime`. No hard bull/bear switch — these are just numbers available for future interaction terms in the calibration fit. (e) **Governance rewiring**: the learner's auto-guard now trips on CHAMPION HEALTH (>15% drawdown from a 90-day NAV peak, OR calibration-decile drift >0.25, OR data-availability <60% over the last 10 observations) instead of a raw 3-run win-rate streak — win-rate ignores payoff asymmetry and doesn't reflect real risk. Confirmed the guard only ever gated `update_signal_weight`; hypothesis-writing, validation, and shadow research were already unaffected.
Reason: Each piece targets a specific, named ceiling from the original review: the genome answers "can the system evolve more than 5 weights," the feature registry answers "can it discover new signals," shadow decisions answer "can a challenger be observed live before risking capital," regime features answer "can scoring be regime-aware without a brittle switch," and the governance rewire answers "is the safety mechanism measuring the right risk." All five are additive and default-inert — nothing here changes today's live scoring/sizing/promotion behavior until a human deliberately proposes a genome change, a feature clears IC promotion, or a version is explicitly put into shadow_paper.
Alternatives considered: Let the LLM write and run arbitrary feature code (rejected outright — no code-execution surface, ever, per this project's LLM/deterministic-boundary rule); auto-promote validated challengers into shadow without human action (rejected — exploration must stay bounded and opt-in, matching the project's human-in-the-loop mandate); keep the win-rate auto-guard (rejected — Codex review + this session's own audit found it measured the wrong thing).
Impact: The learnable surface now includes entry/horizon/exit/sizing/universe/regime, not just 5 weights. Feature discovery has a real (if narrow, whitelisted) path from LLM hypothesis to validated, IC-promoted signal. Shadow decisions accrue silently and cost nothing until a version is placed in `shadow_paper`. Auto-guard now reflects realized risk, not a noisy short-run win-rate. Nothing here is live/active by default.
Files/features affected: `supabase/migrations/063_strategy_genome.sql`, `064_feature_registry.sql`, `065_shadow_decisions.sql`, `lib/validation/genome.ts`, `feature-compiler.ts`, `feature-check.ts`, `regime.ts`, `app/api/validation/feature-check/route.ts`, `lib/research-agent.ts` (shadow recording + regime features), `app/api/agents/learner/route.ts` (propose_feature tool + governance rewire), `scripts/run-agents.ps1` / `register-tasks.ps1`, `public/agent-diagrams/system-map.json` (GENOME/REGISTRY/SHADOW nodes).
Reversal cost: Low (five additive schema pieces; genome/registry/shadow are all opt-in and read-gated, so removing them affects nothing already in production use)

### Decision 38: Risk posture & goal tracker — goals are measured, postures are applied; return targets are never agent parameters

Date: 2026-07-06
Status: Approved
Category: Architecture / Risk

Context: The posture/goals spec was queued to close two gaps: (1) the conservative/balanced/aggressive profiles didn't scale kill-switch thresholds or exit hysteresis, so an aggressive book with default -5%/20%/40% thresholds tripped by design; (2) there was no way to time-box a more aggressive posture with an automatic revert, and no way to track a stated return goal without that goal leaking into agent sizing/thresholds.
Decision: (a) **Profile rollup**: `strategy_config` gains `ks_daily_loss_pct, ks_drawdown_pct, ks_accuracy_pct, exit_hysteresis`, populated per-profile in both the PROFILES map (`app/api/settings/risk-profile/route.ts`) and `checkKillSwitches`/`position-monitor` reads (resilient — absent/null falls back to the original hardcoded -5/20/40/15 defaults). Settings shows a muted note when a promoted champion overrides scoring weights. (b) **Time-bound postures**: `strategy_config.posture/posture_expires_at/base_risk_profile` — applying a posture saves the current profile as the revert target, applies that posture's dials with an expiry, and journals to `decision_journal`. The research cron checks and auto-reverts expired postures before each run (resilient no-op pre-migration). (c) **Goal tracker**: new `trading_goals` table (explicitly commented "READ BY UI ONLY — never an agent input"), `/api/goals` computes required-vs-realized daily-return feasibility as a pure function (`lib/goals/feasibility.ts`) and auto-flips status to achieved/missed. A dashboard `GoalCard` shows progress, an on-track marker, and an honest feasibility sentence. **A return target is never wired into sizing/threshold** — cranking dials toward a target only adds variance (gambler's ruin) and would teach the learner that luck is skill.
Reason: Kill-switches and exit hysteresis that don't scale with the chosen risk profile fight the profile's own intent. Postures need a safety valve (auto-revert) so a temporary aggressive stance can't be forgotten and left permanent. Goals are valuable as an honest progress readout but dangerous as a control input — locking that boundary in code (a commented, agent-unread table) prevents future drift toward "goal-seeking" agent behavior.
Alternatives considered: Wire goal targets into position sizing directly (rejected — locked design rule, see spec); hardcoded bull/bear regime switching for postures (rejected — already covered by Phase 2 Kelly sizing + Phase 3 regime router, no duplicate hardcoded switch).
Impact: Aggressive profiles no longer trip on thresholds sized for balanced. A posture can be applied and will self-revert without manual follow-up. Users get a feasibility-checked goal readout without any risk of it silently becoming an agent input.
Files/features affected: `lib/kill-switches.ts`, `app/api/agents/position-monitor/route.ts`, `app/api/settings/risk-profile/route.ts`, `app/api/agents/research/cron/route.ts` (posture auto-revert), `app/dashboard/settings/page.tsx` (posture UI + champion note), `lib/goals/feasibility.ts`, `app/api/goals/route.ts`, `components/dashboard/GoalCard.tsx`, `components/dashboard/DashboardHome.tsx`.
Reversal cost: Low (all additive columns/tables, resilient fallbacks throughout; removing the goal card or posture UI has zero effect on trading behavior since neither ever fed an agent)

### Decision 39: 30-day agent-run calendar, broker adapter registry (swap/multi-broker), fortnightly model-freshness checker

Date: 2026-07-06
Status: Approved
Category: Architecture / Ops

Context: Three visibility/flexibility gaps closed together: (1) no at-a-glance view of which agents ran/failed/were missing over the last month; (2) the Execution Gateway called `lib/brokers/alpaca-orders.ts` directly — swapping to Kite/E*TRADE/any other broker meant editing routes, and `broker_orders.broker` had a column nothing routed on; (3) no visibility into whether a newer or soon-to-be-deprecated LLM exists for an already-integrated provider.
Decision: (a) **Agent calendar** (`/api/agents/calendar` + `AgentCalendar.tsx`, rendered at the top of the dashboard): aggregates `agent_runs` over 30 days, classifies each (date, agent) cell ok/error/partial/skipped/missing. The expected-agent-set is derived from what's actually registered in `pg_cron` (no `strategy_config.market_focus` column exists — the spec's assumption was stale; used real schedule state instead). (b) **Broker adapter registry**: `lib/brokers/adapter-types.ts` (`BrokerAdapter` interface — distinct from the pre-existing `types.ts`, which is holdings-aggregation types, not the order-execution contract) + `lib/brokers/registry.ts` (`getBroker`/`listBrokers`/`getActiveBroker`, resilient fallback to alpaca/kite) + adapters wrapping the existing `alpaca-orders.ts` and `lib/kite.ts` functions (added `kiteDelete` for cancellation). `strategy_config.active_broker_us/active_broker_india` (default alpaca/kite) drive routing; `/api/broker/orders` and `/api/broker/orders/sync` now go through the registry only — the sync loop iterates distinct brokers present in open orders, so multiple brokers can have in-flight orders simultaneously. Settings gained a per-market broker dropdown with a configured/not-configured badge. (c) **Model freshness** (`/api/models/check`, weekly `pg_cron`): diffs `agent_config`'s assignments against each provider's live model list (Anthropic/Groq/DeepSeek, each fail-soft), flags newer-available and possibly-deprecated models into `model_check_results` + an info/warn alert. Never auto-switches — a dashboard card just surfaces findings; the human changes the assignment in the existing agent-config picker.
Reason: Silent scheduling failures are worse than loud ones — the calendar makes "PC off/asleep at trigger time" visible at a glance instead of requiring a manual `agent_runs` query (exactly what this session's investigation had to do manually). The broker registry removes a permanent one-broker lock-in with zero added complexity to the safety gates (which sit above the adapter layer, untouched). Model freshness is informational-only by design — auto-switching models is a bigger decision than a background job should make.
Alternatives considered: Gate the calendar's expected-set on `strategy_config.market_focus` per the spec's original text (rejected — that column doesn't exist; used the actual `pg_cron` schedule as ground truth instead); auto-switch to a newer model when found (rejected — model choice affects cost/quality/behavior and needs a human in the loop, matching the project's approval-gate philosophy).
Impact: Missed/failed cron runs are now visible without a manual DB query. Adding a future broker (E*TRADE, etc.) is one file + one registry line, zero route changes. Deprecated or newer models surface proactively instead of being discovered when an agent silently starts failing.
Files/features affected: `app/api/agents/calendar/route.ts`, `components/dashboard/AgentCalendar.tsx`, `components/dashboard/DashboardHome.tsx`; `lib/brokers/adapter-types.ts`, `lib/brokers/registry.ts`, `lib/brokers/adapters/{alpaca,kite}.ts`, `lib/kite.ts` (added `kiteDelete`), `app/api/broker/orders/route.ts`, `app/api/broker/orders/sync/route.ts`, `app/api/brokers/route.ts`, `app/dashboard/settings/page.tsx` (broker dropdown); `app/api/models/check/route.ts`, `components/dashboard/ModelFreshnessCard.tsx`, `components/dashboard/AgentsPage.tsx`; migrations `model_check_results`, `broker_registry_config`; `pg_cron` job `kairos-model-check`.
Reversal cost: Low (additive schema + a routing indirection; removing the registry would mean reverting the two Gateway routes to direct alpaca-orders calls, a small diff)

### Decision 40: Research Journal — daily per-symbol funnel trail + learning-evolution view

Date: 2026-07-06
Status: Approved
Category: Architecture / Observability

Context: "Why did the agent do/not do X today" required manually cross-referencing 4+ tables by hand — no single place showed the full chain (score → screener bucket → research pass/fail → Portfolio Constructor decision → fill) for a symbol on a given day, and nothing showed whether the learning loop is actually improving over weeks. Also discovered while building this: `decision_observations.signal_id` had been hardcoded `null` on every insert since Phase 1 shipped (comment read "agent_signals insert doesn't return id today — Phase 2 wires it") — the join key the whole ledger was designed around was never actually wired.
Decision: (a) Fixed the `agent_signals` insert in `lib/research-agent.ts` to capture its returned id and thread it into `decision_observations.signal_id` (previously always null). (b) `runScreener` now returns each symbol's bucket (momentum|value) instead of a flattened list, recorded into `decision_observations.features.screener` with the fixed criteria set for that bucket. (c) New append-only `pipeline_stage_events` table (signal_id, stage, outcome, reason, detail) — written by ResearchAgent (stage='research'), Portfolio Constructor's decision point and the fill/reject paths in `paper-trade/route.ts` (stage='portfolio_constructor', stage='execution'), all fail-soft (never blocks the decision they describe). (d) New `feature_registry_history` table logging every status transition (written from `feature-check` and the learner's `propose_feature` tool). (e) Two new routes (`/api/agents/research-journal`, `.../evolution`) and one new page (`/dashboard/research-journal`, Daily Funnel + Evolution tabs) — the Evolution tab explicitly refuses to draw a trend from fewer than 3 data points rather than imply false precision on thin history.
Reason: Instrumenting at the source (one small insert at each existing decision point) is the only way to get an honest trail — reconstructing "why" after the fact from final-state tables is lossy (a Portfolio-Constructor rejection before a `trade_proposals` row ever existed left zero trace before this). The dormant `signal_id` bug would have silently undermined this and any other future join through `decision_observations` had it not been caught while scoping this feature.
Alternatives considered: Build the journal as a pure read-only aggregation over existing tables (rejected — the join key didn't work and downstream rejection reasons weren't captured anywhere); auto-alert on funnel anomalies as part of this feature (rejected — out of scope, that's the existing stale-run/0-signal alerting, this is for understanding why, not re-alerting).
Impact: Every symbol scored going forward has a queryable, honest stage-by-stage trail. `decision_observations.signal_id` now actually joins to `agent_signals`/`paper_trades` for the first time. Feature-registry promotions/retirements now have a timeline, not just a snapshot.
Files/features affected: `lib/research-agent.ts`, `app/api/agents/paper-trade/route.ts`, `app/api/validation/feature-check/route.ts`, `app/api/agents/learner/route.ts` (`propose_feature`), `app/api/agents/research-journal/route.ts`, `app/api/agents/research-journal/evolution/route.ts`, `app/dashboard/research-journal/page.tsx`, `components/dashboard/DashboardShell.tsx` (nav); migrations `pipeline_stage_events`, `feature_registry_history`; `features/research-journal/FEATURE_ARCHITECTURE.md`.
Reversal cost: Low (additive tables/fields, fail-soft writes throughout; the signal_id fix is a pure improvement with no reversal case)

### Decision 41: Renormalize scoring weights across applicable+available dimensions instead of always applying the fixed 5-way split

Date: 2026-07-06
Status: Approved
Category: Architecture / Scoring methodology

Context: Reviewing the Research Journal surfaced that ETFs (IAU, GDX, etc.) were being scored using the same fixed 30/25/20/15/10 (fundamental/technical/sentiment/macro/insider) weighting as individual stocks, even though fundamental and insider are structurally meaningless for an ETF (no company financials, no insiders — `scoreFundamentals`/`normalizeInsiderScore` already returned a flat neutral baseline for these cases, not a real signal). Separately, macro was frequently unavailable (Alpha Vantage rate-limited) and still counted at its full fixed weight against a neutral-50 default. Also found and fixed in the same pass: `scoreSentiment()` checked for field names (`bullish_pct`/`bull_pct`) that never matched the real StockTwits/AV data shape (`stocktwits_bullish_pct`, `av_news_sentiment`) — sentiment was silently always neutral-50 regardless of real (sometimes strongly bullish) data.
Decision: `lib/research-agent.ts`'s weighted score now classifies each of the 5 dimensions as included or excluded before computing `analystScore`: **inapplicable** (fundamental/insider for ETFs — structural, not data-dependent) or **unavailable** (macro rate-limited, no sentiment data this run — `scores.dataQuality` flags). When 2-4 dimensions are included, weights are renormalized to sum to 1.0 across only those; below 2 included dimensions, falls back to the original fixed-weight behavior (renormalizing a score to 100% of one thin signal is riskier than the old diluted approach). The applied weights and included-dimension list are recorded into `decision_observations.features.weighting` and `weights_used` (now the actually-applied weights, not the base profile split), surfaced in the Research Journal funnel view.
Reason: A fixed weight applied against a fabricated neutral-50 default silently penalizes candidates for a data gap that has nothing to do with their real quality — an ETF was never going to have real insider data, and that shouldn't cost it 10% of its score every single run. Renormalizing across what's actually knowable is more honest than diluting with placeholders.
Alternatives considered: A per-instrument-type weight profile (e.g. a dedicated ETF weight set) — rejected as a partial fix that doesn't handle the *unavailable* case (macro rate-limiting affects stocks too) and adds another hardcoded table to maintain; leaving the fixed weights and only fixing the sentiment bug — rejected, the ETF fundamental/insider exclusion is a distinct, real issue independent of the sentiment bug.
Impact: ETF and thin-data scores should shift upward (no longer penalized by inapplicable/unavailable dimensions) and become more honest about what evidence actually drove them — visible per-symbol in the Research Journal.
Files/features affected: `lib/research-agent.ts` (renormalization logic + `weighting` in `features`), `lib/data/scores.ts` (`scoreSentiment` field-name fix), `app/api/agents/research-journal/route.ts` + `app/dashboard/research-journal/page.tsx` (surface `weighting`).
Reversal cost: Low (renormalization only changes weight distribution when dimensions are excluded; degenerate case falls back to prior behavior exactly)

### Decision 42: Ultra-review fix pass — same-day kill-switch bug, screener bucket bias, Alpaca status regression, currency-blind outcome classification, missing migration files

Date: 2026-07-06
Status: Approved
Category: Bug fix batch / Process

Context: Ran a 10-angle multi-agent adversarial review (line-by-line, removed-behavior, cross-file, language-pitfall, wrapper-correctness, reuse, simplification/efficiency, altitude, conventions) plus a deeper follow-up pass over the full session's diff, specifically because the density of silent defects found earlier in the session (dormant `signal_id` null, sentiment field-name mismatch, missing `profiles.market_focus`) raised the question of whether the core scoring/learning loop could be trusted at all.
Decision: Fixed, in priority order: (1) `checkKillSwitches`'s daily-loss check compared `todayPerf` — a row only written at the END of the same `paper-trade` run that calls it — against yesterday, so the same-day circuit breaker could never actually fire same-day; now compares live current NAV (already in scope) against yesterday's close. (2) `runScreener`'s momentum-then-value insertion order let momentum silently crowd out every value-bucket candidate whenever momentum alone returned 6+ hits; now interleaves both buckets round-robin before the 6-slot cap — a pre-existing bias, not introduced this session, but now visible via the Research Journal. (3) `getAlpacaOrder`'s unmapped-status fallback was accidentally changed from passing through the raw status string to `undefined` during tonight's type-error fix, silently hiding any order in one of Alpaca's ~8 unmapped statuses from the sync job — extended the map to cover all of them. (4) Posture `Object.assign` ran after per-field overrides in the same PATCH request, silently clobbering an explicit override; reordered so explicit fields always win, and a cancel-when-nothing-active request now returns `no_op:true` instead of a silent 200. (5) `getActiveBroker` swallowed all errors (not just missing-column) and now logs loudly on any non-schema failure. (6) Broker sync's reconciliation only ever checked Alpaca holdings — Kite/India fills had zero reconciliation path; added the missing check. (7) None of ~10 schema changes applied live via the Supabase MCP tool this session had a committed migration file — backfilled as `supabase/migrations/072`-`080`. (8) `PROFILES`/`PROFILE_DIALS`/kill-switch fallback constants were three independent hand-typed copies of the same numbers — consolidated into `lib/risk-profiles.ts`. (9) Win/loss/breakeven classification used a fixed absolute `±$0.5` band regardless of currency, meaningless for India (₹) — switched to a relative `±0.1%` band via a shared `lib/trade-outcome.ts` helper. (10) Several smaller fixes: weight-renormalization all-zero-weight edge case now falls back to an equal split instead of silently zeroing every score; a manual-close qty-mismatch check now logs loudly instead of silently miscrediting cash; `lib/schedule.ts`'s `model-check` entry had contradictory days/time metadata; Research Journal's evolution "agreement %" was renamed to `wouldEnterPct` since no actual champion-agreement comparison is computed; `PROJECT_BUILD_LOG.md` hadn't been updated since 2026-06-29 despite 4 major decisions shipping.
Reason: A safety mechanism that structurally cannot fire when it's supposed to, and a screener that structurally excludes half its candidate pool, are both worse than a slow feature — they look like they work (return 200, log nothing) while silently not doing their job. Fixing the process gap (no committed migrations for live schema changes) matters as much as the code bugs, since it's the same root-cause class: state that's real but invisible.
Alternatives considered: Leaving `lotOutcome()` in `lib/paper/lot-math.ts` alone rather than also converting it to a relative band — it's dead code (only referenced by its own test, no production caller), so it was left as-is rather than risk touching a passing test suite for a non-live code path; noted as a follow-up cleanup, not urgent.
Impact: The daily-loss kill switch can now actually trip same-day. The screener no longer structurally favors momentum over value. Kite/India orders are now reconciled. All of tonight's schema has a committed, reproducible migration file.
Files/features affected: `lib/kill-switches.ts`, `lib/research-agent.ts`, `lib/brokers/alpaca-orders.ts`, `lib/brokers/registry.ts`, `lib/brokers/adapters/kite.ts`, `app/api/broker/orders/sync/route.ts`, `app/api/settings/risk-profile/route.ts`, `app/api/agents/research/cron/route.ts`, `lib/risk-profiles.ts` (new), `lib/trade-outcome.ts` (new), `app/api/paper-positions/close/route.ts`, `app/api/agents/position-monitor/route.ts`, `app/api/goals/route.ts`, `components/dashboard/GoalCard.tsx`, `lib/schedule.ts`, `app/api/agents/research-journal/{route,evolution/route}.ts`, `supabase/migrations/072`-`080`, `PROJECT_BUILD_LOG.md`.
Reversal cost: Low — every change either restores previously-intended behavior (kill switch, Alpaca status, posture override) or is a pure additive safety net (qty-mismatch logging, zero-weight fallback).
