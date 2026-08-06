-- `get_daily_ai_count` is called directly from the authenticated browser. It
-- used SECURITY DEFINER to read RLS-protected usage_logs but accepted any UUID,
-- letting one signed-in user query another user's recent activity count.
--
-- Retain the browser contract while making the caller-to-user binding explicit.
create or replace function public.get_daily_ai_count(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is distinct from p_user_id then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return (
    select count(*)::integer
    from public.usage_logs
    where user_id = p_user_id
      and action = 'ai_query'
      and created_at > now() - interval '24 hours'
  );
end;
$$;

revoke execute on function public.get_daily_ai_count(uuid) from public, anon;
grant execute on function public.get_daily_ai_count(uuid) to authenticated, service_role;
