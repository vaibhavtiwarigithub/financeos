CREATE TABLE IF NOT EXISTS api_key_vault (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_name text NOT NULL UNIQUE,     -- env var name: 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY'
  key_value text NOT NULL,           -- stored as-is (RLS protects it, service-only access)
  display_name text NOT NULL,        -- 'DeepSeek Chat'
  provider text NOT NULL,            -- 'deepseek' | 'gemini' | 'openai' | 'groq' | 'anthropic'
  model_id text,                     -- primary model: 'deepseek-chat', 'gemini-2.5-flash'
  tasks_suitable text[] DEFAULT '{}', -- ['chat','summarize']
  cost_per_1m_input numeric DEFAULT 0,
  cost_per_1m_output numeric DEFAULT 0,
  enabled boolean DEFAULT true,
  notes text,
  added_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE api_key_vault ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_only" ON api_key_vault FOR ALL USING (true);

-- Seed existing known keys (values stored in env, vault just tracks metadata)
INSERT INTO api_key_vault (key_name, display_name, provider, model_id, tasks_suitable, cost_per_1m_input, cost_per_1m_output, notes) VALUES
('ANTHROPIC_API_KEY', 'Claude Sonnet 4.6', 'anthropic', 'claude-sonnet-4-6', ARRAY['research','trade','evaluate','thesis'], 3.00, 15.00, 'Primary agent - Anthropic Max plan'),
('DEEPSEEK_API_KEY', 'DeepSeek Chat', 'deepseek', 'deepseek-chat', ARRAY['chat','summarize'], 0.07, 0.28, '$10 budget loaded 2026-06-29'),
('MASSIVE_API_KEY', 'Massive (Polygon) Market Data', 'massive', null, ARRAY['data'], 0, 0, 'Free tier - price history, quotes'),
('GROQ_API_KEY', 'Groq Llama 3.3 70B', 'groq', 'llama-3.3-70b-versatile', ARRAY['screen','summarize'], 0, 0, 'Free tier - fast screening pre-filter, 14400 req/day')
ON CONFLICT (key_name) DO NOTHING;
