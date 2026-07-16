-- India Markets snapshot — scheduled full fill.
--
-- Runs the FULL India snapshot fill (indices + NSE sectors + NIFTY-50 breadth,
-- paced) once the NSE cash session has closed. NSE closes 15:30 IST = 10:00 UTC
-- year-round (India has no DST), so two post-close ticks at 10:15 and 10:45 UTC
-- on weekdays capture the completed session. The fill is idempotent-by-append
-- (the GET path serves the latest row), so the second tick is cheap resilience.
--
-- kairos_call_agent injects the x-cron-secret header the route verifies. Display
-- data only — never on the money/scoring path.

do $$
declare j text;
begin
  foreach j in array array['kairos-india-markets-fill','kairos-india-markets-fill-retry']
  loop
    begin
      perform cron.unschedule(j);
    exception when others then null;
    end;
  end loop;
end $$;

select cron.schedule('kairos-india-markets-fill', '15 10 * * 1-5',
  $$select public.kairos_call_agent('/api/markets/india', '{}'::jsonb, 'POST', 65000)$$);

select cron.schedule('kairos-india-markets-fill-retry', '45 10 * * 1-5',
  $$select public.kairos_call_agent('/api/markets/india', '{}'::jsonb, 'POST', 65000)$$);
