-- Migration 135: mandate_id FK on agent_signals, paper_trades, decision_observations
-- Nullable first — backfill in application code before making NOT NULL.

alter table public.agent_signals
  add column if not exists mandate_id uuid references public.investment_mandates(id);

alter table public.paper_trades
  add column if not exists mandate_id uuid references public.investment_mandates(id);

alter table public.decision_observations
  add column if not exists mandate_id uuid references public.investment_mandates(id);

-- Indexes for evaluation queries
create index if not exists agent_signals_mandate_idx
  on public.agent_signals(mandate_id, market, created_at desc);

create index if not exists paper_trades_mandate_idx
  on public.paper_trades(mandate_id, market);

create index if not exists dobs_mandate_idx
  on public.decision_observations(mandate_id, market, ts desc);

-- Backfill existing rows using default mandates seeded in migration 133.
-- US rows → 'Swing US 2-20d', India rows → 'Swing India 2-20d'.
-- Safe to run multiple times (WHERE mandate_id IS NULL guard).

update public.agent_signals s
set mandate_id = (
  select m.id from public.investment_mandates m
  where m.name = case when s.market = 'india' then 'Swing India 2-20d' else 'Swing US 2-20d' end
    and m.active = true
  limit 1
)
where s.mandate_id is null;

update public.paper_trades t
set mandate_id = (
  select m.id from public.investment_mandates m
  where m.name = case when t.market = 'india' then 'Swing India 2-20d' else 'Swing US 2-20d' end
    and m.active = true
  limit 1
)
where t.mandate_id is null;

update public.decision_observations o
set mandate_id = (
  select m.id from public.investment_mandates m
  where m.name = case when o.market = 'india' then 'Swing India 2-20d' else 'Swing US 2-20d' end
    and m.active = true
  limit 1
)
where o.mandate_id is null;
