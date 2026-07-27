-- Robinhood MCP capability observation (P0).
-- This records only the tools/list contract fingerprint. It is not evidence,
-- does not call tools/call, and is deliberately outside scoring and execution.

create table if not exists public.broker_mcp_capability_snapshots (
  id bigint generated always as identity primary key,
  broker text not null check (broker = 'robinhood'),
  market text not null check (market = 'us'),
  observed_at timestamptz not null,
  status text not null check (status in ('available', 'contract_changed', 'unavailable')),
  tool_count integer not null check (tool_count >= 0),
  tool_names jsonb not null default '[]'::jsonb,
  schema_fingerprint text,
  error_code text,
  created_at timestamptz not null default now(),
  check (
    (status in ('available', 'contract_changed') and schema_fingerprint is not null and error_code is null)
    or (status = 'unavailable' and schema_fingerprint is null and error_code is not null)
  )
);

create index if not exists broker_mcp_capability_snapshots_lookup_idx
  on public.broker_mcp_capability_snapshots (broker, observed_at desc);

alter table public.broker_mcp_capability_snapshots enable row level security;
revoke all on table public.broker_mcp_capability_snapshots from anon, authenticated;

drop trigger if exists no_mutate on public.broker_mcp_capability_snapshots;
create trigger no_mutate before update or delete on public.broker_mcp_capability_snapshots
  for each row execute function public.evidence_block_mutation();

select cron.unschedule(jobid)
from cron.job
where jobname = 'kairos-robinhood-mcp-capability-snapshot';

select cron.schedule(
  'kairos-robinhood-mcp-capability-snapshot',
  '0 4 * * 1',
  $$select public.kairos_call_agent('/api/broker-mcp/robinhood/capability-snapshot', '{}'::jsonb, 'POST', 55000)$$
);
