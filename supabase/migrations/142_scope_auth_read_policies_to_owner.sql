-- Security: the SELECT policies on these tables were TO authenticated USING(true),
-- so ANY authenticated Supabase user (if email self-signup is ever enabled) could
-- read the owner's entire trading history/config directly via PostgREST, bypassing
-- requireOwner + middleware. Scope them to the owner email (defense-in-depth; the
-- app is single-owner). service_role bypasses RLS, so all server writes are
-- unaffected. Mirrors the owner-scoping already done for the secret tables.

ALTER POLICY auth_read_dj  ON public.decision_journal
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_da  ON public.deep_analyses
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_mi  ON public.mentor_insights
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_strategy_config ON public.strategy_config
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_td  ON public.trade_decisions
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_tp  ON public.trade_proposals
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_utf ON public.uploaded_trade_files
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY authenticated_only ON public.paper_trades
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
