-- Decision 78 / Stage A: daily evidence only. The endpoint executes MCP
-- tools/list and writes a capability snapshot; it never calls a market, quote,
-- preview, or order tool.
do $$
begin
  perform cron.unschedule('kairos-crypto-capability-probe');
exception when others then
  null;
end $$;

select cron.schedule(
  'kairos-crypto-capability-probe',
  '5 0 * * *',
  $$select public.kairos_call_agent('/api/agents/crypto-capability-probe', '{}'::jsonb, 'POST', 60000)$$
);
