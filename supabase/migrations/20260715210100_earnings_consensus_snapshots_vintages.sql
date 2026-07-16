-- Append-only pre-announcement consensus VINTAGES (features/known-anomalies §3).
-- Each row is a snapshot of the market's consensus EPS for an upcoming report,
-- captured strictly BEFORE the announcement so we begin accumulating the "last
-- valid consensus before announcement" that PEAD surprise needs. Immutable log:
-- application only INSERTs. DATA CAPTURE ONLY — nothing on the money path reads it.
--
-- available_at = when we could first know this consensus value (point-in-time).
-- analyst_count is nullable: the free provider (Finnhub calendar) does not expose
-- a contributor count, and the coverage report is meant to surface exactly that gap.

create table if not exists public.earnings_consensus_snapshots (
  id             uuid        primary key default gen_random_uuid(),
  symbol         text        not null,
  market         text        not null default 'us' check (market in ('us','india')),
  report_date    date,
  fiscal_period  text,
  consensus_eps  numeric,
  analyst_count  integer,
  basis          text,
  currency       text        default 'USD',
  source         text,
  snapshot_at    timestamptz not null default now(),
  available_at   timestamptz not null default now()
);

-- Latest-vintage lookups per (symbol, market, report_date); newest first.
create index if not exists earnings_consensus_snapshots_symbol_report_idx
  on public.earnings_consensus_snapshots (symbol, market, report_date, snapshot_at desc);

-- SECURITY: new public table MUST ship RLS-on. Deny anon; authenticated (owner)
-- may SELECT. Writes happen via service_role (bypasses RLS). No INSERT/UPDATE
-- policy on purpose — only the server may append. Matches symbol_profiles /
-- earnings_calendar security pattern.
alter table public.earnings_consensus_snapshots enable row level security;

drop policy if exists earnings_consensus_snapshots_authenticated_read on public.earnings_consensus_snapshots;
create policy earnings_consensus_snapshots_authenticated_read
  on public.earnings_consensus_snapshots for select to authenticated using (true);
