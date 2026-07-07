-- Deep-Dive, Markets Thesis, Markets Synthesis, and Backtest Optimize were
-- each hardcoded to a specific model in code (mostly DeepSeek already, for
-- lack of ANTHROPIC_API_KEY; backtest-optimize was still hardcoded to real
-- Claude Haiku with no fallback, though never actually called yet). Adding
-- agent_config rows lets all four be changed from Settings -> Agents -> LLM
-- Config, same as research/learner/mentor/theme-scout/briefing already are.

insert into agent_config (agent_name, model, enabled, max_tokens, notes)
values
  ('deep-dive', 'deepseek-reasoner', true, 2048, 'Deep-Dive Debate (analyst/bull/bear/PM). Configurable — was hardcoded deepseek-chat/deepseek-reasoner split.'),
  ('markets-thesis', 'deepseek-reasoner', true, 2048, 'Markets page AI thesis (1-day/1-week/next-session). Was hardcoded deepseek-chat.'),
  ('markets-synthesis', 'deepseek-reasoner', true, 2048, 'Markets page cross-asset synthesis. Was hardcoded deepseek-chat.'),
  ('backtest-optimize', 'deepseek-reasoner', true, 2048, 'Backtest strategy-optimization suggestions. Was hardcoded claude-haiku-4-5 with no fallback — never actually called yet, would have failed instantly (no ANTHROPIC_API_KEY).')
on conflict (agent_name) do nothing;
