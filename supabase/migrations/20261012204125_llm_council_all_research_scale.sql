-- Council scores every research symbol (owner request 2026-10-12): lift the 5/day cap, allow 3 parallel leases per worker,
-- and give queued subscription jobs 12h instead of 45 minutes (local workers drain a queue of ~130 jobs per member per day).
alter table public.llm_council_config drop constraint if exists llm_council_config_max_symbols_per_market_day_check;
alter table public.llm_council_config add constraint llm_council_config_max_symbols_per_market_day_check check (max_symbols_per_market_day >= 1 and max_symbols_per_market_day <= 400);
alter table public.llm_council_batches alter column deadline set default (now() + interval '12 hours');
do $$
declare d text; p1 text; p2 text;
begin
  d := pg_get_functiondef('public.council_subscription_claim(text)'::regprocedure);
  p1 := replace(d, 'if exists(select 1 from public.llm_council_jobs x join', 'if (select count(*) from public.llm_council_jobs x join');
  if p1 = d then raise exception 'claim function head not found'; end if;
  p2 := replace(p1, 'y.deadline>now()) then return null; end if;', 'y.deadline>now()) >= 3 then return null; end if;');
  if p2 = p1 then raise exception 'claim function tail not found'; end if;
  execute p2;
end $$;
