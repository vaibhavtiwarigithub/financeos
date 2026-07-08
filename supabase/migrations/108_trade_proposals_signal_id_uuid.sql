-- Risk fix G1 prerequisite: trade_proposals.signal_id was declared bigint (migration 037)
-- but agent_signals.id / decision_observations.signal_id are uuid — so the trader's
-- `signal_id: signal.id` (a uuid) never linked, and live orders can't be joined back to
-- their decision-quality record. Convert to uuid.
--
-- Safe: the only existing row has signal_id = null (the type mismatch prevented any real
-- value from ever landing), so no data is lost.
alter table trade_proposals alter column signal_id type uuid using null::uuid;

comment on column trade_proposals.signal_id is 'uuid FK-by-value to agent_signals.id / decision_observations.signal_id. Links a live proposal back to its research decision for the data-quality gate.';
