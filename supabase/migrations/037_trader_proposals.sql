-- Phase 5: TraderAgent proposals — approval-required live order flow
-- An order cannot reach Robinhood without: proposal → risk check → user explicit approval → gateway submit

create table if not exists trade_proposals (
  id              bigserial primary key,
  -- What
  symbol          text not null,
  side            text not null check (side in ('buy', 'sell')),
  qty             integer not null,
  order_type      text not null default 'market' check (order_type in ('market', 'limit')),
  limit_price     numeric(12,4),
  -- Evidence
  signal_id       bigint,
  strategy_version_id bigint references strategy_versions(id),
  analyst_score   integer,
  thesis          text,
  key_risks       text[],
  -- Price at proposal time
  price_at_proposal numeric(12,4),
  price_source      text,
  price_retrieved_at timestamptz,
  -- Risk checks (computed at proposal time)
  risk_check_pass boolean,
  risk_check_reasons jsonb,
  -- Portfolio impact at proposal time
  estimated_value numeric(14,2),
  pct_of_nav      numeric(6,4),
  new_position_count integer,
  -- Tax/dividend flags
  tax_flags       jsonb,
  dividend_flags  jsonb,
  -- Approval flow
  status          text not null default 'pending_review' check (status in (
    'pending_review',   -- awaiting user action
    'approved',         -- user approved — gateway will submit
    'rejected',         -- user rejected
    'expired',          -- approval window passed
    'submitted',        -- sent to Robinhood
    'filled',           -- Robinhood confirmed fill
    'failed',           -- submission failed
    'cancelled'         -- cancelled after submission
  )),
  approval_expires_at timestamptz,  -- proposals expire after 30 min
  approved_at     timestamptz,
  rejected_at     timestamptz,
  rejection_reason text,
  -- Execution
  robinhood_order_id text,
  fill_price      numeric(12,4),
  fill_qty        integer,
  filled_at       timestamptz,
  -- Robinhood order review payload (what the user sees before approving)
  rh_review_payload jsonb,
  -- Account safety
  account_number  text not null default '605420660',  -- HARDCODED — never overridable
  -- Audit
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table trade_proposals disable row level security;
create index if not exists tp_status_idx on trade_proposals(status, created_at desc);
create index if not exists tp_symbol_idx on trade_proposals(symbol, status);
create index if not exists tp_expiry_idx on trade_proposals(approval_expires_at) where status = 'pending_review';

-- Decision journal: links decisions to evidence and outcomes
create table if not exists decision_journal (
  id              bigserial primary key,
  entry_type      text not null,  -- 'signal' | 'paper_fill' | 'paper_exit' | 'trade_proposal' | 'learner_run' | 'experiment'
  -- References (nullable — link whichever apply)
  signal_id       bigint,
  paper_trade_id  bigint,
  paper_event_id  bigint,
  trade_proposal_id bigint,
  experiment_run_id bigint,
  learner_run_id  bigint,
  strategy_version_id bigint,
  -- Content
  symbol          text,
  summary         text not null,  -- plain-language 1-sentence summary
  evidence_refs   jsonb,          -- [{table, id, description}] — links to evidence_records, research_packets
  calculations    jsonb,          -- deterministic numbers: scores, weights, sizes
  interpretations jsonb,          -- LLM-produced analysis (clearly labelled)
  outcome         jsonb,          -- filled in when resolved: {pnl, pnl_pct, hold_days, outcome_type}
  -- Content labels (per architecture: every claim labelled)
  has_verified_facts boolean default false,
  has_calculations   boolean default false,
  has_estimates      boolean default false,
  has_interpretations boolean default false,
  has_user_decisions boolean default false,
  resolved        boolean default false,
  resolved_at     timestamptz,
  created_at      timestamptz default now()
);

alter table decision_journal disable row level security;
create index if not exists dj_type_idx on decision_journal(entry_type, created_at desc);
create index if not exists dj_symbol_idx on decision_journal(symbol, created_at desc);
create index if not exists dj_resolved_idx on decision_journal(resolved, entry_type);
