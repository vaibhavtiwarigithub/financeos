-- Continue the migration-142 hardening: scope the remaining authenticated
-- USING(true) SELECT policies on internal/evidence/ledger tables to the owner
-- email, and enable service-role-only RLS on the universe snapshot tables that
-- shipped with no RLS. service_role bypasses RLS, so server reads are unaffected.

ALTER POLICY auth_read_ca  ON public.corporate_actions
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_er  ON public.evidence_records
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_exr ON public.experiment_runs
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_poe ON public.paper_order_events
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_sv  ON public.strategy_versions
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');
ALTER POLICY auth_read_tde ON public.trade_decision_embeddings
  USING ((auth.jwt() ->> 'email') = 'vterminater@gmail.com');

-- universe snapshot tables: enable RLS + service-role-only (evidence, no client read need)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['universe_snapshots','universe_snapshot_scores'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='service_all_'||t) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', 'service_all_'||t, t);
      END IF;
    END IF;
  END LOOP;
END $$;
