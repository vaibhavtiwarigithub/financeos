# ChatGPT Architecture Review — Kairos

**Instructions for Vaibhav:** Copy everything below this line and paste it into a ChatGPT session (GPT-4o or o1 recommended for deep technical review).

---

## REVIEW REQUEST

I'm building **Kairos** — a governed multi-agent quantitative trading research platform running on Next.js 15 / TypeScript / Supabase / Vercel. I have 10 years of Robinhood trade history (6 accounts), a live paper trading loop, and a weekly learning agent. I want an independent expert review of my architecture before I implement Phase 1.

**Please review:**
1. Architecture correctness — gaps, anti-patterns, and missing pieces I haven't considered
2. Technology choices — are the tools I selected the best fit?
3. Sequencing — is Phase 1 the right next step or am I missing a prerequisite?
4. Risk — what could go wrong, and what are the highest-probability failure modes?
5. Finance-specific concerns — anything specific to real-money swing trading systems I'm not accounting for?

---

## SYSTEM OVERVIEW

**Stack:** Next.js 15 App Router, TypeScript, Supabase (PostgreSQL + RLS + Edge Functions), Windows Task Scheduler (cron), Robinhood MCP (read 5 accounts / trade only account `605420660`)

**Agent pipeline (current):**
```
ResearchAgent (cron 9AM ET) 
  → screens 3 candidates/day
  → dual bucket: momentum (RSI>60, price>50d MA) + value (P/E<sector, FCF yield, insider buys)
  → scores 5 dimensions deterministically (no LLM for scores, only thesis)
  → writes agent_signals
  
PaperTrader (cron 9:45AM ET)
  → reads top signals, computes fill price (ask + 0.05% slippage)
  → long-only enforcement
  → writes paper_positions + paper_order_events (append-only, immutable)

LearnerAgent (cron Friday 5PM ET)
  → reads closed paper trades
  → uses claude-opus-4-8 (89% finance accuracy per AIMultiple benchmark)
  → 10 tools including query_trade_decisions (real historical trades)
  → proposes weight adjustments (blocked by phase gate: needs ≥10 closed trades)
  → weekly batch only
```

**Accounts:**
- 5 read-only Robinhood accounts → feed `live_account_snapshots` table
- Account `605420660` (Agentic) = ONLY order placement account
- ResearchAgent reads holdings from ALL accounts for SELL signal generation

**LLM routing:**
- ResearchAgent thesis: Groq 70B (currently; upgrading to Claude Fable 5 proposed)
- LearnerAgent: claude-opus-4-8
- PaperTrader: claude-sonnet-4-6
- Briefing: claude-sonnet-4-6

---

## CURRENT DATABASE STATE

Key tables (all running in production Supabase):
- `live_account_snapshots` — one row per account; positions_json
- `agent_signals` — screener output; asset_class column; ETF seeds for regions
- `paper_positions` — exit management: price_target, stop_loss, highest_price, exit_reason
- `paper_order_events` — immutable; UPDATE/DELETE blocked by trigger
- `evidence_records` — append-only; payload_hash dedup; source tier
- `strategy_versions` + `experiment_runs` — champion/challenger governance
- `trade_decisions` — real historical trades; outcome_score, macro_market_regime, enrichment_status
- `uploaded_trade_files` — SHA-256 dedup for CSV imports
- `macro_regime` + `macro_signals` — MacroSentinel danger score (0-100) from 8 FRED indicators
- `agent_config` — per-agent model/params/enabled stored in DB
- `learning_priors` + `signal_weights_history` — weight rollback support
- `trade_proposals` + `decision_journal` — TraderAgent proposals with 30-min expiry

---

## PLANNED ARCHITECTURE (ITEMS NEEDING REVIEW)

### 1. RAG Pipeline for Trade History

**Goal:** Allow LearnerAgent to semantically search 10 years of trade history. "What patterns worked in rate-hike regimes with high RSI?"

**Proposed:**
- Voyage AI `voyage-3.5` embeddings (finance-tuned, 1536-dim) for each `trade_decisions` row
- Supabase pgvector: new table `trade_decision_embeddings(decision_id uuid, embedding vector(1536), metadata jsonb)`
- IVFFlat index for ANN
- Reranker: `gte-reranker-modernbert-base` (free, HuggingFace) post-retrieval
- New tool `semantic_search_decisions` added to LearnerAgent

**Questions for you:**
- Is Voyage-3.5 the right embedding model for financial trade data? Any better options?
- Is pgvector sufficient for ~50k-100k trade decision rows or do we need Pinecone/Weaviate?
- Is the reranker worth adding at this scale, or overkill?
- Should I embed the full trade context (symbol + action + macro_regime + outcome_score + LLM analysis) or just the LLM analysis text?

### 2. Langfuse Observability

**Goal:** Trace per-agent token usage, latency per tool call, and LLM cost per run.

**Proposed:** Wrap `lib/llm-router.ts` with Langfuse SDK. Each agent run = Langfuse trace. Each tool call = span. Each LLM call = generation.

**Questions for you:**
- Self-hosted or cloud Langfuse? Cost trade-off?
- Any better alternatives for Next.js / Supabase stack? (OpenTelemetry? Helicone?)
- Does this integrate cleanly with Claude Opus 4.8 and Groq simultaneously?

### 3. Firecrawl for ResearchAgent

**Goal:** Crawl full article bodies, SEC EDGAR filing pages, and curated financial sites for deeper research context.

**Proposed:**
- Firecrawl MCP integration into ResearchAgent
- Max 3 crawl calls per run (credit budget)
- Output classified as source tier 4 (unverified hypothesis) — must be corroborated before influencing trade

**Questions for you:**
- Is Firecrawl the right tool or is there a better MCP/API for targeted financial site crawling?
- Any compliance/legal concerns with crawling financial sites for trading research?
- How should I handle rate limits and crawl failures gracefully?

### 4. LangGraph Migration (Future Phase 2+)

**Goal:** Replace sequential HTTP call chain (ResearchAgent → PaperTrader → LearnerAgent) with persistent stateful graph that survives server restarts, supports parallel branches, and has built-in human-in-the-loop checkpoints.

**Current:** Sequential Next.js API calls, no retry, no persistent state.

**Proposed (Phase 2+):** Migrate to LangGraph 1.0 (GA). Each agent = node. State = TypedDict (positions, signals, proposals, approvals). Next.js routes become thin HTTP triggers.

**Questions for you:**
- Is LangGraph the right choice for TypeScript/Next.js or should I use a Python-based orchestrator?
- At what scale/complexity does this migration become worth the overhead?
- What are the failure modes of LangGraph in production that I should know about?

### 5. LLM Model Strategy

**Current model assignments:**
- ResearchAgent thesis: Groq 70B (fast, cheap, good for synthesis)
- LearnerAgent: claude-opus-4-8 (89% finance accuracy)
- PaperTrader / Briefing: claude-sonnet-4-6

**Proposed upgrade:**
- ResearchAgent thesis → Claude Fable 5 (90.34% on AIMultiple finance benchmark, #1)
- Keep Opus 4.8 for LearnerAgent (cost-quality balance)
- Cost constraint: < $2/day at current run frequency (3 research runs + 1 learner/week)

**Questions for you:**
- Is the AIMultiple benchmark a reliable signal for finance LLM selection?
- Is it worth paying for Fable 5 on the thesis generation step vs Groq 70B (which is nearly free)?
- Should different steps within one agent use different models (e.g., fast model for tool calls, powerful model for synthesis)?

---

## CONCERNS I ALREADY HAVE

1. **Overfitting risk in LearnerAgent:** Learning from 10 years of real trades sounds great but most of those trades were made without quant discipline. Will the learner extract noise as signal?

2. **Phase gate tension:** Phase gate requires ≥10 closed paper trades before LearnerAgent can mutate weights. We're early. Learner is running weekly but producing no weight changes. Is this the right gate or too conservative?

3. **Data leakage in enrichment:** The `trade_decisions` enrichment pipeline computes `price_1m_after` for historical trades. When LearnerAgent learns from these, is there any way it could inadvertently use future price information it shouldn't have access to at decision time?

4. **Single Supabase project:** All tables (paper trades, evidence, signals, learner weights, CSV uploads, macro data) are in one Supabase project. Any concerns about scale, RLS complexity, or separation of concerns?

5. **Cron reliability:** Windows Task Scheduler + PowerShell + local machine = single point of failure. No failover. Acceptable trade-off for now?

---

## WHAT I'M NOT ASKING ABOUT

- UI/UX specifics
- Exact DB column names
- CSS / component structure
- Deployment pipeline (intentionally local for now)

---

**I want:** A structured review with specific concerns, specific recommendations, and a prioritized list of what to fix before starting Phase 1 implementation. Be direct. Skip praise.
