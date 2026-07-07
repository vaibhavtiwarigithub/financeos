-- Make the Agent Mind macro-read model user-configurable via Settings → LLM
-- Config (same pattern as the other advisory features). Defaults to the cheap
-- deepseek-reasoner; getConfiguredModel falls back to that if the row is absent.
insert into agent_config (agent_name, model, enabled, max_tokens, temperature, notes)
values ('macro-read', 'deepseek-reasoner', true, 600, 0.4, 'Agent Mind Phase 3: macro-to-holdings interpretation on Markets. Cheap cached daily call; advisory only.')
on conflict (agent_name) do nothing;
