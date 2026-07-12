-- Per-flow LLM selection, part 1 (data).
--
-- (A) The DeepSeek "v4" model ids in agent_config are invalid — deepseek-v4-flash
--     and deepseek-v4-pro both return empty content from the DeepSeek API (see
--     System Health model-fallback alerts). The real API ids are deepseek-chat
--     (V3, cheap) and deepseek-reasoner (R1, the thinking model). Repoint every
--     stored row. The router also carries a legacy alias so any hardcoded v4 id
--     still resolves, but the stored rows should be correct too.
update public.agent_config set model = 'deepseek-chat'     where model = 'deepseek-v4-flash';
update public.agent_config set model = 'deepseek-reasoner'  where model = 'deepseek-v4-pro';

-- (B) Seed rows for the flows the user wants to control from Settings that had no
--     row yet: the core research/trade decision model and the two Mentor surfaces
--     (Evaluate/Judgment + market Thesis). Hard-reasoning flows default to the
--     reasoner (thinking) tier; conversational ask defaults to cheap chat.
--     ON CONFLICT DO NOTHING so re-running never clobbers a user's later choice.
insert into public.agent_config (agent_name, model, enabled, notes) values
  ('research',        'deepseek-reasoner', true, 'Core ResearchAgent thesis/direction model'),
  ('trader',          'deepseek-reasoner', true, 'Trade-decision reasoning model'),
  ('mentor-evaluate', 'deepseek-reasoner', true, 'Judgment Coach — grades your thesis + biases'),
  ('mentor-thesis',   'deepseek-reasoner', true, 'Mentor market-thesis briefing'),
  ('mentor-ask',      'deepseek-chat',     true, 'Ask the Agent — conversational Q&A')
on conflict (agent_name) do nothing;

-- Move core research off the free Groq Llama default onto the reasoner too, so the
-- daily scoring pipeline uses the thinking model (user directive: research on
-- DeepSeek reasoner). Only touches the row if it is still the old Llama default —
-- a deliberate later choice is preserved.
update public.agent_config set model = 'deepseek-reasoner'
where agent_name = 'research' and model = 'llama-3.3-70b-versatile';
