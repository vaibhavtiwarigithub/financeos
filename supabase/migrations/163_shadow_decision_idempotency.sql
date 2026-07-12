-- Prevent repeated shadow cron runs from inflating the evidence sample.
create unique index if not exists shadow_decisions_observation_policy_uidx
on public.shadow_decisions(observation_id, policy_version_id) nulls not distinct
where observation_id is not null;
