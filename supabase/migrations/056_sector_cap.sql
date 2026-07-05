-- Sector concentration cap — a human-set risk guardrail (NOT agent-mutable).
-- Diversification is a safety constraint, not a return knob: letting the
-- LearnerAgent optimize sector concentration for past returns would just teach
-- it to pile into whatever sector was hot, defeating the point. So this is set
-- by the human via the risk profile and enforced deterministically at the
-- PaperTrader buy step, never proposed or changed by an agent.
--   sector  on paper_positions — so open positions can be counted by sector
--   max_positions_per_sector on strategy_config — the cap (per risk profile:
--     conservative 2, balanced 3, aggressive 4)

alter table paper_positions add column if not exists sector text;
alter table strategy_config add column if not exists max_positions_per_sector int default 3;
