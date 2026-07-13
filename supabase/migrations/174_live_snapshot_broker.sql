-- 174: tag each live_account_snapshots row with the broker that produced it.
--
-- WHY: refresh-snapshot captures broker accounts into live_account_snapshots via
-- upsert (auto-ADD). We now want SAFE auto-REMOVE (pruning) of accounts that no
-- longer exist at a broker. Pruning must be scoped to ONE broker's own accounts
-- and only run when that broker's capture SUCCEEDED this run — otherwise an
-- outage (zero accounts returned) would mass-delete rows the kill switch reads
-- for its NAV baseline. That scoping needs a per-row broker tag.
--
-- broker is nullable (no NOT NULL) so historical rows and any writer that hasn't
-- been updated yet keep working. Existing rows are all Robinhood today, so
-- backfill them to 'robinhood'.

alter table public.live_account_snapshots
  add column if not exists broker text;

-- Backfill: every existing row is a Robinhood capture.
update public.live_account_snapshots
  set broker = 'robinhood'
  where broker is null;

-- Speeds up the success-gated prune: delete where broker = <b> and account_id
-- not in (<captured set>).
create index if not exists idx_live_account_snapshots_broker
  on public.live_account_snapshots (broker);
