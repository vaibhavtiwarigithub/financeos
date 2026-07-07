-- System Health funnel: a stable per-condition key so a recurring issue is ONE
-- open row (not duplicates) and can be auto-resolved when the condition clears.
alter table agent_alerts add column if not exists issue_key text;

-- At most one OPEN alert per issue_key. NULL issue_key (ad-hoc alerts) is exempt.
create unique index if not exists agent_alerts_one_open_per_key
  on agent_alerts (issue_key)
  where resolved = false and issue_key is not null;
