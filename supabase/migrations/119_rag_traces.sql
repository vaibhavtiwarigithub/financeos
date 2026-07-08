-- Migration 119 — RAG observability traces (Tier-3 #11 + Tier-4 #14)
--
-- Every retrieval/rerank/filter decision writes one durable trace row here so we
-- can answer "why did the agent see THIS prior trade?" after the fact. This is
-- the in-DB backbone of the observability story; when WANDB_API_KEY is present,
-- lib/observability/weave.ts ALSO mirrors the same span to WandB Weave, but the
-- DB row is the source of truth (never depends on an external service being up).
--
-- Tier-3 #11 "binary context filter": the ticker-mention filter's keep/reject
-- decision for each retrieved chunk is recorded in `filter` so an audit can see
-- exactly which candidates were dropped before they reached the LLM prompt.
--
-- Append-only: rows are inserted, never updated/deleted (matches the
-- decision_observations / learning_log ledger posture).

create table if not exists rag_traces (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  -- Logical operation: 'retrieve' | 'rerank' | 'filter' | 'index'
  op            text not null,
  -- What triggered it, e.g. 'research-thesis', 'index-on-close', 'backfill'
  source        text,
  symbol        text,
  market        text,
  -- Free-form span payload: query text, k, candidate ids, distances, kept/rejected
  -- counts, rerank scores, filter decisions. JSON so the shape can evolve.
  span          jsonb not null default '{}'::jsonb,
  -- Binary-context-filter summary (Tier-3 #11): {kept:int, rejected:int, reasons:[]}
  filter        jsonb,
  latency_ms    integer,
  ok            boolean not null default true,
  err           text
);

comment on table rag_traces is
  'Tier-3 #11 / Tier-4 #14 RAG observability: durable span per retrieve/rerank/filter/index op. Mirrored to WandB Weave when WANDB_API_KEY set; DB row is source of truth. Append-only.';

create index if not exists rag_traces_ts_idx on rag_traces (ts desc);
create index if not exists rag_traces_op_idx on rag_traces (op);
create index if not exists rag_traces_symbol_idx on rag_traces (symbol);

alter table rag_traces enable row level security;

drop policy if exists rag_traces_service_all on rag_traces;
create policy rag_traces_service_all on rag_traces
  for all to service_role using (true) with check (true);
