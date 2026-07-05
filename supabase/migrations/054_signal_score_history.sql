-- Score-history per stock: append-only log of every dimension score computed
-- for a symbol over time, so score changes can be charted and the research/
-- learner agents can reason about trend ("this symbol's score has risen over
-- N runs") instead of only ever seeing the single current agent_signals row
-- (which gets overwritten/upserted per symbol, no history retained).
-- Spec'd in PRD.md section 9.6-adjacent ("Chart: 30-day price + agent score
-- history") but never built — this is that data model.

create table if not exists signal_score_history (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  analyst_score numeric,
  fundamental_score numeric,
  technical_score numeric,
  sentiment_score numeric,
  macro_score numeric,
  insider_score numeric,
  direction text,
  source text, -- 'research' | 'scanner' | 'deep-dive' etc — which agent computed this
  created_at timestamptz not null default now()
);

create index if not exists signal_score_history_symbol_idx on signal_score_history (symbol, created_at desc);

alter table signal_score_history enable row level security;
create policy "service_role_all_signal_score_history" on signal_score_history
  for all to service_role using (true) with check (true);
create policy "authenticated_read_signal_score_history" on signal_score_history
  for select to authenticated using (true);
