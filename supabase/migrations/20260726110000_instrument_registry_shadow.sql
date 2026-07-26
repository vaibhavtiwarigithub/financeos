-- Observed instrument type is intentionally separate from trading permission.
-- L0 records current classifications only; it cannot enable a candidate, alter a
-- score, or affect PaperTrader/live execution.
create table if not exists public.instrument_registry (
  market text not null check (market in ('us', 'india')),
  symbol text not null,
  instrument_kind text not null check (instrument_kind in (
    'us_equity', 'adr', 'etf', 'metal_fund', 'leveraged_or_inverse_etf', 'india_equity'
  )),
  classification_source text not null check (classification_source in (
    'market_suffix', 'curated_adr', 'curated_static', 'inferred_equity'
  )),
  classification_confidence text not null check (classification_confidence in ('curated', 'derived', 'inferred')),
  review_status text not null default 'observe' check (review_status in ('observe', 'reviewed', 'blocked')),
  new_entry_allowed boolean not null default false,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  primary key (market, symbol),
  check (new_entry_allowed = false or review_status = 'reviewed')
);

create index if not exists instrument_registry_kind_market_idx
  on public.instrument_registry (market, instrument_kind, last_observed_at desc);

alter table public.instrument_registry enable row level security;
revoke all on table public.instrument_registry from public, anon, authenticated;

comment on table public.instrument_registry is
  'Observed instrument classification registry. L0 is observational and cannot authorize a new entry.';
