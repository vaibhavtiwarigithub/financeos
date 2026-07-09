-- 129 — Reconcile agent_config to each flow's CURRENT hardcoded model, so that
-- wiring those callsites to getConfiguredModel() (Settings-LLM Part 1) is
-- behavior-preserving: the model actually used after the change equals the model
-- used before it. Only then does the LLM Config panel tell the truth.
--
-- Before this, three rows LIED (panel said one model, code ran another):
--   theme-scout : panel deepseek-v4-flash → code hardcoded llama-3.3-70b-versatile
--   briefing    : panel llama-3.3         → code ran deepseek-v4-flash (routing default + literal)
--   mentor      : panel deepseek-v4-flash → code hardcoded deepseek-v4-pro
--
-- Set each row to the code's real current model. Model-only update (never touches
-- `enabled`). Additive/idempotent. After this + the code wiring, the panel is
-- authoritative and the user can freely re-point any of these from Settings.

insert into public.agent_config (agent_name, model, enabled) values
  ('theme-scout', 'llama-3.3-70b-versatile', true),
  ('briefing',    'deepseek-v4-flash',       true),
  ('mentor',      'deepseek-v4-pro',         true)
on conflict (agent_name) do update set model = excluded.model;
