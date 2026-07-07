-- New India-specific morning/evening briefing crons, anchored to NSE hours
-- (previously briefing/generate was US-only and ET-anchored regardless of
-- market_focus -- India never got its own brief at all).
--
-- brief-morning-india: 09:50 AM IST (04:20 UTC) -- 20min after
-- kairos-research-india (09:30 AM IST) so the day's India signals/paper-fill
-- have already landed before the brief summarizes them.
-- brief-evening-india: 04:30 PM IST (11:00 UTC) -- 45min after
-- kairos-position-monitor-india (03:45 PM IST) and NSE's 03:30 PM close.

select cron.schedule('kairos-brief-morning-india', '20 4 * * 1-5',
  $$select kairos_call_agent('/api/briefing/generate', '{"session":"morning","market":"india"}'::jsonb, 'POST', 70000)$$);

select cron.schedule('kairos-brief-evening-india', '0 11 * * 1-5',
  $$select kairos_call_agent('/api/briefing/generate', '{"session":"evening","market":"india"}'::jsonb, 'POST', 70000)$$);
