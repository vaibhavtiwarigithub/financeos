-- Synthetic (TEST-NO-REAL-ASSET) council batches: raise the rolling 24h cap from 5 to 20 (owner-approved 2026-10-12).
-- Patches the live function definition in place and fails loudly if the expected text is not found.
do $$
declare d text; patched text;
begin
  d := pg_get_functiondef('public.council_subscription_enqueue(text,jsonb,text,uuid[],integer,bigint)'::regprocedure);
  patched := replace(d, '>=5 then raise exception ''synthetic_daily_cap''', '>=20 then raise exception ''synthetic_daily_cap''');
  if patched = d then raise exception 'synthetic cap text not found; function unchanged'; end if;
  execute patched;
end $$;
