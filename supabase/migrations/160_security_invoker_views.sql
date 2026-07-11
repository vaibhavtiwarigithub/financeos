-- 160: Supabase security-advisor remediation.
-- Views must evaluate RLS as the caller, not as their creator. The service-role
-- API paths continue to work; direct authenticated access cannot bypass the
-- underlying table policies.
alter view public.v_decision_quality set (security_invoker = true);
alter view public.provider_budget_7d set (security_invoker = true);

-- SECURITY DEFINER functions must not resolve attacker-controlled objects from
-- a mutable search_path.
alter function public.get_daily_ai_count(uuid)
  set search_path = public, pg_temp;
