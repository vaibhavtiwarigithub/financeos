-- Supabase default sequence grants are broader than this trigger-only ledger.
revoke all on sequence public.paper_position_plan_events_id_seq from public,anon,authenticated,service_role;
