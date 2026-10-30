-- Restrict direct service-role writes to the minimum needed by the collector.
-- Lifecycle/config creation goes through audited SECURITY DEFINER RPCs.
revoke all on public.strategy_template_shadow_configs from service_role;
grant select on public.strategy_template_shadow_configs to service_role;

revoke all on public.strategy_template_shadow_events from service_role;
grant select on public.strategy_template_shadow_events to service_role;
revoke all on sequence public.strategy_template_shadow_events_id_seq from service_role;

revoke all on public.strategy_template_shadow_decisions from service_role;
grant select, insert on public.strategy_template_shadow_decisions to service_role;

revoke all on public.strategy_template_shadow_outcomes from service_role;
grant select, insert on public.strategy_template_shadow_outcomes to service_role;

grant usage, select on sequence public.strategy_template_shadow_decisions_id_seq,
  public.strategy_template_shadow_outcomes_id_seq to service_role;
