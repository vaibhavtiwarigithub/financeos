-- Remote version 20260928183837; applied through Supabase MCP (project dionkikgdmlaotvtbnfr), 12 active jobs verified.
-- Schedule the four leveraged-sleeve PAPER doors through pg_cron.
--
-- They were only listed in vercel.json. Production never ran them (0 agent_runs rows for
-- soxl_cron/tqqq_cron/sqqq_cron/soxs_cron, 0 leveraged paper trades) because this project's
-- real schedules are pg_cron -> kairos_call_agent, not Vercel Cron (Hobby plan).
--
-- Entry windows (ET): SOXL 11:00, TQQQ 11:20, SQQQ 11:40, SOXS 12:00, each 15 minutes. Each route
-- refuses entry outside its America/New_York window, so BOTH UTC hours are scheduled all year and
-- only the one inside the window can enter; the other is an in-session monitor/liveness run.
-- After-close monitor (full-day range) must run after the 16:00 ET close but while the quote is
-- still fresh: 20:xx UTC in EDT months (Mar-Oct), 21:xx UTC in EST months (Nov-Feb). A 21:xx run in
-- EDT would see a stale quote and raise a false monitor warning, so it is not scheduled.
-- Paper only: no broker call, no live flag, no order. The live door
-- (/api/agents/leveraged-live/cron) is NOT scheduled here.
begin;

do $$ begin perform cron.unschedule('kairos-soxl-entry'); exception when others then null; end $$;
select cron.schedule('kairos-soxl-entry', '5 15,16 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/soxl/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-soxl-close-edt'); exception when others then null; end $$;
select cron.schedule('kairos-soxl-close-edt', '15 20 * 3-10 1-5',
  $$select public.kairos_call_agent('/api/agents/soxl/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-soxl-close-est'); exception when others then null; end $$;
select cron.schedule('kairos-soxl-close-est', '15 21 * 11,12,1,2 1-5',
  $$select public.kairos_call_agent('/api/agents/soxl/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-tqqq-entry'); exception when others then null; end $$;
select cron.schedule('kairos-tqqq-entry', '25 15,16 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/tqqq/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-tqqq-close-edt'); exception when others then null; end $$;
select cron.schedule('kairos-tqqq-close-edt', '20 20 * 3-10 1-5',
  $$select public.kairos_call_agent('/api/agents/tqqq/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-tqqq-close-est'); exception when others then null; end $$;
select cron.schedule('kairos-tqqq-close-est', '20 21 * 11,12,1,2 1-5',
  $$select public.kairos_call_agent('/api/agents/tqqq/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-sqqq-entry'); exception when others then null; end $$;
select cron.schedule('kairos-sqqq-entry', '40 15,16 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/sqqq/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-sqqq-close-edt'); exception when others then null; end $$;
select cron.schedule('kairos-sqqq-close-edt', '25 20 * 3-10 1-5',
  $$select public.kairos_call_agent('/api/agents/sqqq/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-sqqq-close-est'); exception when others then null; end $$;
select cron.schedule('kairos-sqqq-close-est', '25 21 * 11,12,1,2 1-5',
  $$select public.kairos_call_agent('/api/agents/sqqq/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-soxs-entry'); exception when others then null; end $$;
select cron.schedule('kairos-soxs-entry', '0 15,16 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/soxs/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-soxs-close-edt'); exception when others then null; end $$;
select cron.schedule('kairos-soxs-close-edt', '30 20 * 3-10 1-5',
  $$select public.kairos_call_agent('/api/agents/soxs/cron', '{}'::jsonb, 'GET', 58000)$$);

do $$ begin perform cron.unschedule('kairos-soxs-close-est'); exception when others then null; end $$;
select cron.schedule('kairos-soxs-close-est', '30 21 * 11,12,1,2 1-5',
  $$select public.kairos_call_agent('/api/agents/soxs/cron', '{}'::jsonb, 'GET', 58000)$$);

commit;
