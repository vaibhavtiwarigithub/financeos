-- 128 — Standalone per-market paper-trade crons (decouple fills from research)
--
-- Problem: paper fills only happened as a tail-call chained at the END of
-- /api/agents/research/cron. When the US research run hangs before that chain
-- (MCP cold-start / long fetch), ZERO US fills land while pending signals pile
-- up — starving the learning/metrics/evolution loop. India research is lighter,
-- completes, and chains its fill fine — the entire US/India fill asymmetry.
--
-- Fix: a standalone paper-trade cron per market that fills fresh same-trading-day
-- signals independent of whether research finished its chain. Safe because
-- migration 126/127 added:
--   - market-local same-trading-day freshness (stale pending → expired, never filled)
--   - claim ownership (claim_run_id) so the chain and this cron can BOTH run
--     without double-filling (route pending→claiming CAS + RPC claiming→paper_traded CAS)
--
-- The research→paper-trade chain is intentionally LEFT IN PLACE as a backstop
-- for now (Phase 3 removes it after 2–3 clean standalone days). Overlap is safe.
--
-- Timing (UTC, EDT summer — shift 1h at the Nov EST changeover):
--   US:    research fires 13:00 (09:00 ET, pre-open, scores off yesterday's close).
--          This cron fires 14:05 (10:05 ET, ~35m after the 09:30 open) so the fill
--          lands on a live intraday quote, on the SAME US calendar day the signals
--          were written → passes the America/New_York freshness cutoff.
--   India: research fires 04:00 (09:30 IST). This cron fires 11:05 (16:35 IST,
--          after the 15:30 close) — same IST calendar day → passes the Asia/Kolkata
--          freshness cutoff. India is a pure backstop (its chain already works).
--
-- 120s timeout: up to ~10 signals × (quote + sector + vol + RPC). No LLM calls.

do $$
declare j text;
begin
  foreach j in array array['kairos-paper-trade-us','kairos-paper-trade-india']
  loop
    begin
      perform cron.unschedule(j);
    exception when others then null;
    end;
  end loop;
end $$;

select cron.schedule('kairos-paper-trade-us', '5 14 * * 1-5',
  $$select kairos_call_agent('/api/agents/paper-trade?market=us', '{}'::jsonb, 'POST', 120000)$$);

select cron.schedule('kairos-paper-trade-india', '5 11 * * 1-5',
  $$select kairos_call_agent('/api/agents/paper-trade?market=india', '{}'::jsonb, 'POST', 120000)$$);
