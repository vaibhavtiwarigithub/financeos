-- 161: Atomic, market-scoped champion promotion.
create or replace function public.promote_strategy_champion(p_version_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_market text; v_validation_id bigint; v_state text; v_passed boolean;
begin
  select market, validation_experiment_id, state into v_market, v_validation_id, v_state
  from public.strategy_versions where id = p_version_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'strategy version not found'; end if;
  if v_market not in ('us','india') then raise exception 'invalid strategy market'; end if;
  if v_state in ('retired','rejected') then raise exception 'retired/rejected strategy cannot be promoted'; end if;
  if v_validation_id is null then raise exception 'passed validation is required'; end if;
  select passed into v_passed from public.validation_experiments
  where id = v_validation_id and challenger_id = p_version_id;
  if coalesce(v_passed,false) is not true then raise exception 'passed validation is required'; end if;
  perform pg_advisory_xact_lock(hashtext('strategy-promotion:' || v_market));
  update public.strategy_versions set is_champion = false
  where market = v_market and is_champion = true and id <> p_version_id;
  update public.strategy_versions set is_champion = true, state = 'paper_active', promoted_at = now()
  where id = p_version_id;
  if not found then raise exception 'promotion update failed'; end if;
  return jsonb_build_object('promoted',p_version_id,'market',v_market);
end; $$;
revoke all on function public.promote_strategy_champion(bigint) from public, anon, authenticated;
grant execute on function public.promote_strategy_champion(bigint) to service_role;
