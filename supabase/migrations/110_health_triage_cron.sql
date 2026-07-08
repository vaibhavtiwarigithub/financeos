-- Self-healing Part B: run the health-triage agent every 6 hours (heartbeat).
-- Read-only SRE triage over open alerts + recent errors + data-quality/provider health.
select cron.schedule('kairos-health-triage', '0 */6 * * *',
  $$select kairos_call_agent('/api/agents/health-triage')$$);
