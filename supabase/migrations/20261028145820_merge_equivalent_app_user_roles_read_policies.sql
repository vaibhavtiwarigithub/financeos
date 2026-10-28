-- Collapse the existing permissive SELECT-policy union without changing which
-- rows are visible. No write policy or table grant is modified.
DROP POLICY IF EXISTS app_user_roles_owner_read ON public.app_user_roles;
DROP POLICY IF EXISTS app_user_roles_self_read ON public.app_user_roles;

CREATE POLICY app_user_roles_owner_or_self_read
  ON public.app_user_roles
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR ((SELECT auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text
  );
