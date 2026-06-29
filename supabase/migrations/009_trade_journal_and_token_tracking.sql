-- Trade Journal: link per-trade learning notes to specific trades
ALTER TABLE learning_log ADD COLUMN IF NOT EXISTS trade_id UUID REFERENCES paper_trades(id);
CREATE INDEX IF NOT EXISTS idx_learning_log_trade_id ON learning_log(trade_id) WHERE trade_id IS NOT NULL;

-- Token tracking: record Claude CLI usage per agent run
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tokens_input INTEGER;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tokens_output INTEGER;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS claude_calls INTEGER DEFAULT 0;

-- Performance indexes for journal queries
CREATE INDEX IF NOT EXISTS idx_paper_trades_signal_id ON paper_trades(signal_id) WHERE signal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_signals_packet_id ON agent_signals(research_packet_id) WHERE research_packet_id IS NOT NULL;
