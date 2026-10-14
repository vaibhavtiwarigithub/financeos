-- Nothing ever closed out a trade proposal whose approval window had passed: the only route to 'expired' was a late approve attempt, so
-- 147 buy ideas (30-minute window) sat in pending_review for up to 3 months. They inflated the portfolio "proposal impact" panel, which
-- counts every pending_review row, and showed as awaiting approval. This sweeper moves them to the existing 'expired' status.
-- Only status and updated_at change; the row, price, thesis and expiry timestamp are kept, so history and the recommendation tracker are intact.

create or replace function public.expire_stale_trade_proposals()
returns integer
language plpgsql
set search_path = public
as $$
declare n integer;
begin
  update public.trade_proposals
     set status = 'expired', updated_at = now()
   where status = 'pending_review'
     and approval_expires_at is not null
     and approval_expires_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.expire_stale_trade_proposals() from public, anon, authenticated;

-- One-time backfill happens on the first run below; then every 5 minutes (the reminder job needs proposals still pending only while
-- their window is open, which this never touches).
select public.expire_stale_trade_proposals();
select cron.schedule('kairos-expire-stale-proposals', '*/5 * * * *', $$select public.expire_stale_trade_proposals()$$);
