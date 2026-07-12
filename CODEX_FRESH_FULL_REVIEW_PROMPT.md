# Codex reviewer prompt — Kairos / FinanceOS fresh full-app review (unanchored)

> Paste everything below the line into Codex (GPT-5). Reviewer prompt only.
> The "Builder" step (implementing fixes) is run afterward by Claude Code,
> once `FRESH_FULL_REVIEW.md` exists.

---

You are a senior staff engineer, quant-systems architect, security reviewer, and
live-money trading risk engineer reviewing Kairos / FinanceOS.

Repo path:
`C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS`

Output file to create/overwrite:
`C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS\FRESH_FULL_REVIEW.md`

## STEP -1 — SCORE-BLIND MANDATE (read first, non-negotiable)

This is a FRESH, INDEPENDENT review. Prior audits of this repo exist and assigned
numeric scores (e.g. an earlier "X/10" overall). You must:

- NOT read, open, search for, or reference any prior review's score, grade, or verdict.
  Files like `POST_UPGRADE_FIX_LOG.md`, `07_08_FULL_APP_REVIEW.md`, `CODEX_*_RESULT.md`,
  and any `*_REVIEW.md` that contains a past score are OFF-LIMITS as anchors. If you open
  one to understand history, IGNORE every score/grade/verdict inside it.
- NOT anchor your assessment to, agree with, or react against any earlier rating.
  Do not try to "match", "beat", or "confirm" a previous number.
- Evaluate the codebase as it exists TODAY, on its own evidence. Derive every conclusion
  from code you actually opened and quoted — never from a prior reviewer's opinion.
- If you assign any score, build it bottom-up from THIS review's confirmed findings only,
  and state explicitly: "Derived independently; no prior score consulted." A score is
  optional — a precise findings list is the real deliverable.

If you catch yourself recalling or citing a previous rating, stop and re-derive from code.

## STEP 0 — Prove your access before reviewing (put results in "Review limitations")

You have filesystem + shell access to the repo. Before trusting any claim that you also
have Supabase access, PROVE it by running these READ-ONLY queries against the live DB and
pasting raw output into "Review limitations":

```sql
-- 1. live row counts (not derivable from any repo file)
select count(*) as paper_trades, max(created_at) as latest from paper_trades;

-- 2. applied-migration list — MUST include the newest migrations if DB access is real
select version from supabase_migrations.schema_migrations order by version desc limit 12;

-- 3. tables that only exist after the newest migrations (149/150/151)
select count(*) from replay_packets;          -- migration 149
select count(*) from fundamental_facts;        -- migration 150
select column_name from information_schema.columns
  where table_name='agent_signals' and column_name in ('rank_pct','rank_rejected');  -- migration 151
```

Then state, in one line, HOW you reached Supabase: MCP tool name, `psql`, or supabase CLI,
and which project ref.

- If query 2 does NOT include 149/150/151, or query 3 errors "relation does not exist" /
  returns no rows, you do NOT have live DB access. Say so. Verify schema ONLY against
  `supabase/migrations/*.sql` and mark every schema finding `[SUSPECTED]`, never
  `[CONFIRMED]`. Do NOT assume migrations are unapplied — 149/150/151 ARE applied.

### READ-ONLY GUARD — hard rule for the entire review
- SELECT statements only. NO `insert`, `update`, `delete`, `alter`, `drop`, `create`,
  `apply_migration`, or any write. A reviewer must never mutate the live database.
- Never touch append-only ledgers. Do not run anything that writes rows anywhere.
- If you believe a write is needed to verify something, describe it as a proposed step —
  do not execute it.

## ACCESS + HONESTY CONTRACT
- Tag EVERY finding: `[CONFIRMED]` = you opened the file and quoted the exact offending
  code with the real line number, or `[SUSPECTED]` = inferred / could not fully verify.
  Wrong findings are discarded — be precise.
- Never invent a `file:line`. If you didn't read the file, say so under "Review limitations."
- Do not invent issues to fill sections. An empty section is a valid result — list it under
  "Clean sections."
- Rank findings by real-world blast radius: money/order-path first, then data-integrity,
  security, correctness, then everything else.

## GROUND-TRUTH INVARIANTS — INTENTIONAL. Do NOT flag as bugs. DO flag code that VIOLATES them.
- Order placement: account `605420660` is the ONLY account permitted to place orders.
  `965848641` is read-only. Robinhood agentic account is separate and is the only one used
  for Robinhood live orders.
- New positions are LONG-ONLY. SELL signals ARE allowed on existing holdings — correct, not
  a long-only hole.
- Human approval REQUIRED before any live order at the current stage. No autonomous live
  order path is supposed to exist yet. Flag CRITICAL if one does.
- `verifyCronSecret()` intentionally returns a boolean and is timing-safe. Correct.
- RAG / embeddings / rerank / trace paths are env-gated (e.g. `JINA_API_KEY` /
  `WANDB_API_KEY`): absent key → graceful no-op returning null, NEVER throws. Deliberate
  graceful-degradation. Flag ONLY if a MONEY/order/risk path fails-open the same way.
- Screener target is max 3 candidates/day; intentionally NO explicit bull/bear regime
  switch — locked product decisions, not oversights.
- Append-only ledgers (`decision_observations`, `observation_labels`, `paper_order_events`,
  `broker_orders`/order events, `learning_log`, `strategy_versions`, and the new
  `fundamental_facts`, `replay_*` tables) must never be deleted or rewritten. Corrections
  are new events/rows. Do NOT propose deleting them; prefer additive migrations.
- The newest features are OFF BY DEFAULT and behavior-neutral by design (see below). Their
  presence is intentional. Flag only real defects in them, not their existence.

## NEW-SINCE-LAST-REVIEW SURFACE — review these with extra care
These landed recently and are OFF by default. Verify they are genuinely behavior-neutral
when off, and that turning them on cannot corrupt money/data paths:

1. **Cross-sectional rank** (migration 151). Adds `universe_snapshot_scores` cols
   (`rank_quality`, `comparable_group_key`, `group_n`, `rank_eligible`) and `agent_signals`
   cols (`rank_pct`, `rank_rejected`) + `agent_signals_rank_pct_range` check ([0,1]).
   Genome knob `entry.rank_pct_min` (default `0.0` = OFF). Gate is claimed to admit across
   comparable groups only; intra-group ordering stays by `analyst_score` (preserves the
   locked "top-3 by analyst_score win" decision). VERIFY: with `rank_pct_min = 0.0` the
   selection is byte-identical to before; the check constraint can't reject valid signals;
   no NULL/divide-by-zero in percentile math; group keying can't silently drop candidates.
   Spec: `features/cross-sectional-rank/FEATURE_ARCHITECTURE.md`.

2. **PIT fundamentals ledger** (migration 150, `fundamental_facts`). Append-only vintage
   ledger; read via `lib/data/pit-fundamentals.ts:getFundamentalsAsOf`; written by the
   capture-on-fetch hook in `lib/research-agent.ts`. Claimed NOT wired into live scoring —
   `scoreFundamentals` unchanged, default scores byte-identical. VERIFY: capture hook can't
   throw into a scoring/order path; `payload_hash` dedup is correct; as-of read uses
   `COALESCE(filing_date, captured_at::date)` at query time (the index is plain columns,
   since a `timestamptz::date` cast is not IMMUTABLE); no future-data leak in as-of reads.
   Spec: `features/pit-fundamentals/FEATURE_ARCHITECTURE.md`.

3. **Historical replay harness** (migration 149: `replay_packets`,
   `replay_packet_items`, `replay_eligibility_runs`, `replay_eligibility_events`). Sealed
   data accessor must raise `FutureDataLeakError` on any as-of violation. VERIFY: the sealed
   accessor cannot be bypassed; replay can't write into live tables; RLS is service-role-only
   (these 4 tables are intentionally RLS-enabled-no-policy = service-only lockdown, NOT a
   missing-policy bug).

## CONTEXT
Kairos / FinanceOS is a personal agentic quant-trading OS for one user: Next.js 15,
Supabase/Postgres, TypeScript, scheduled agents, Robinhood MCP, Kite/Zerodha, Alpha Vantage,
Massive/FMP-style data providers, multi-LLM routing (Claude/DeepSeek/others), paper trading,
live-account snapshots, live order gateways, risk profiles, learning/decision journals, daily
briefings, and agent self-improvement. US equities/ETFs + India/Zerodha.

Long-term goal is autonomous live trading, but ONLY after the system proves itself through
paper → shadow → manual-approved live → explicit owner promotion into bounded autonomous mode.

## READ FIRST (in order; verify each exists before relying on it)
1. AGENTS.md
2. WORK_LOG.md
3. CLAUDE.md (project operating rules + locked decisions)
4. docs/arch/00-index.md, then the relevant `docs/arch/NN-*.md` chapters
5. PROJECT_DECISIONS.md
6. knowledge/KNOWLEDGE_INDEX.md, knowledge/CONNECTIONS.md
7. public/agent-diagrams/system-map.json (graph of the whole system)
8. features/cross-sectional-rank/, features/pit-fundamentals/, features/*/FEATURE_ARCHITECTURE.md
9. Relevant migrations, API routes, lib files, components, scripts, docs referenced above.

Do not rely only on docs. Verify against actual code and the live Supabase schema if STEP 0
proved access.

# REVIEW SCOPE

## 1. Product / architecture fit
Does the system match the intended product: governed multi-agent research + trading;
long-only new positions; human approval before live orders now; future bounded-autonomous
path after evidence; self-improving but never bypassing safety-critical controls;
US + India pipelines; paper/shadow/journal/briefing/explanation layers; free/cheap data used
without corrupting analysis on provider-limit; learns without overfitting or fake confidence.
Flag any mismatch between intended product and actual code.

## 2. Live-money safety (highest priority)
Every path that can affect live orders, budget reservation, order review, account snapshots,
risk checks, settings. Hunt for:
- Any current path to broker submission without owner approval / approved autonomy mode.
- Any path to broker submission with wrong account selection; RH agentic vs read-only confusion.
- Kite/Zerodha path bypassing controls present in the US path.
- BUY vs SELL asymmetry; long-only holes; SELL allowed only if held.
- Duplicate submit / retry / double-click races; idempotency keys.
- Partial fill / reconcile / ambiguous broker response handling.
- Kill-switch behavior, incl. resting orders left unmanaged after kill.
- Per-order vs cumulative exposure caps; daily budget correctness; USD/INR currency mixing;
  NAV/equity fallback; position concentration, sector exposure, buying power, liquidity, vol.
- Stale quote / stale snapshot / price-drift correctness.
- ANY fail-open where live money is involved.
- Whether overrides are owner-gated, durable, auditable, unavailable to agents/cron unless
  autonomy mode explicitly allows.
For each: exact `file:line`, failure scenario, concrete fix, and fail behavior.

## 3. Supabase / Postgres / schema
Migration order + schema coupling (code that reads a column/table/RPC that a migration must
have created — verify the migration is APPLIED, not just present on disk); SECURITY DEFINER
functions + `search_path`; RLS policies + service-role usage; anon/authenticated access to
sensitive tables; append-only ledger integrity; type mismatches (uuid/bigint, numeric/text,
jsonb assumptions); null / divide-by-zero / empty-array / missing-weight handling; race
conditions in RPCs and insert flows; unique indexes + idempotency; currency/day scoping in
budget tables; IMMUTABLE-in-index-expression pitfalls; check constraints that could reject
valid rows. Give special attention to migrations 149/150/151 per the New-Surface section.

## 4. Correctness, concurrency, money math
Scoring math, position sizing, budget arithmetic, percentile/rank math, currency conversion,
timezone/market-calendar handling, cron idempotency and cold-start timeouts, LLM routing
fallbacks, provider-limit degradation, retry/backoff, and any place a NaN/Infinity/NULL can
poison a downstream money or selection decision.

## 5. Security
Secrets handling, `.env` / vault usage, cron-secret verification, SSRF/injection in provider
calls, prompt-injection reachability into order paths, RLS bypass, over-broad service-role,
and any untrusted-content path that could drive a side-effectful action.

## 6. Tests / observability
Whether money/order/risk paths have tests; whether tests would actually catch a regression in
the invariants above; log/audit coverage for every state transition on a live order.

# OUTPUT FORMAT for `FRESH_FULL_REVIEW.md`
1. **Review limitations** — STEP 0 raw output, access method, what you could NOT verify.
2. **Independent verdict** — your assessment derived only from this review; if you give a
   score, state "Derived independently; no prior score consulted."
3. **CRITICAL findings** (money/order/data-loss/security) — each: `[CONFIRMED|SUSPECTED]`,
   `file:line`, quoted code, failure scenario, concrete fix, fail behavior.
4. **HIGH / MEDIUM / LOW findings** — same shape.
5. **New-surface findings** — anything specific to migrations 149/150/151 features.
6. **Clean sections** — what you checked and found solid.
7. **Prioritized fix list** — ordered by blast radius, each mapped to a finding above.

Be precise, quote code, and stay score-blind. A short list of CONFIRMED real defects is worth
more than a long list of speculation.
