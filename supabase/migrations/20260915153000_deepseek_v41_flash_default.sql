-- Owner-approved 2026-09-15: normalize every configurable flow to the current
-- DeepSeek V4.1 Flash API ID.  This changes only future LLM calls; it never
-- rewrites historical llm_call_log rows or their recorded model provenance.
--
-- `deepseek-flash` is the provider's current V4.1 Flash ID.  V4 Pro remains a
-- deliberate Settings choice, but no existing agent is left on it by accident.
update public.agent_config
set model = 'deepseek-flash',
    updated_at = now()
where model is distinct from 'deepseek-flash';

-- A vault row may carry a model label for diagnostics.  The credential itself
-- remains unchanged; normalize only legacy DeepSeek labels so diagnostics match
-- the effective routing above.
update public.api_key_vault
set model_id = 'deepseek-flash'
where provider = 'deepseek'
  and model_id in ('deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro');
