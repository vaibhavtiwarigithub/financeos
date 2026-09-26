-- Remote migration version: 20260925160844 (applied through Supabase MCP).
-- Reconcile the detection-only, code-version IC regression alerts after the
-- market-local dimension diagnostics have finished. The endpoint is
-- owner/cron-gated and does not influence scores or trading.
begin;

do $$ begin perform cron.unschedule('kairos-ic-regression-ledger-us'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('kairos-ic-regression-ledger-india'); exception when others then null; end $$;

select cron.schedule(
  'kairos-ic-regression-ledger-us', '30 23 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/ic-regression-ledger?market=us', '{}'::jsonb, 'POST', 60000)$$
);
select cron.schedule(
  'kairos-ic-regression-ledger-india', '35 23 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/ic-regression-ledger?market=india', '{}'::jsonb, 'POST', 60000)$$
);

commit;
