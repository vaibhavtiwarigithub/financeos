-- DeepSeek retires the legacy deepseek-chat/deepseek-reasoner aliases on
-- 2026-07-24 15:59 UTC. Move every configurable flow to the concrete V4 IDs.

update public.agent_config
set model = case model
  when 'deepseek-chat' then 'deepseek-v4-flash'
  when 'deepseek-reasoner' then 'deepseek-v4-pro'
  else model
end
where model in ('deepseek-chat', 'deepseek-reasoner');

update public.api_key_vault
set model_id = case model_id
  when 'deepseek-chat' then 'deepseek-v4-flash'
  when 'deepseek-reasoner' then 'deepseek-v4-pro'
  else model_id
end
where provider = 'deepseek'
  and model_id in ('deepseek-chat', 'deepseek-reasoner');
