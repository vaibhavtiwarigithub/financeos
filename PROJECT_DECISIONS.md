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
