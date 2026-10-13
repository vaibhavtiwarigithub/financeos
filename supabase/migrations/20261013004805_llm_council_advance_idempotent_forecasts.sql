-- Backfill support (2026-10-12): finalization may be re-run for a batch whose run was already finalized (append-only evidence).
-- Forecast rows that already exist must be skipped, not collide; the run row is untouched (its update is guarded by status='running').
do $$
declare d text; p text;
begin
  d := pg_get_functiondef('public.council_subscription_advance(uuid)'::regprocedure);
  p := replace(d, 'j.submitted_at);', 'j.submitted_at) on conflict (run_id,model_requested,execution_source) do nothing;');
  if p = d then raise exception 'advance insert anchor not found'; end if;
  execute p;
end $$;
