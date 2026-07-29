-- Keep owner reads and proposal lookups efficient as the append-only ledger grows.

drop policy if exists earnings_risk_owner_read
  on public.earnings_risk_observations;

create policy earnings_risk_owner_read
  on public.earnings_risk_observations
  for select to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

create index if not exists earnings_risk_observations_proposal_idx
  on public.earnings_risk_observations (proposal_id)
  where proposal_id is not null;
