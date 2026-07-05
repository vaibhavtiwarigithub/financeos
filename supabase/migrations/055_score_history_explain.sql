-- Make each score-history point self-explaining so the Score Tracker can show
-- "what changed" when a point is clicked, without fragile join-by-timestamp:
--   rationale            — the thesis/summary from the research run that produced
--                          this score (why the agent scored it this way)
--   research_packet_id   — link to the full research_packets row for deeper drill-down
--   used_champion_weights— whether this score was computed with the promoted
--                          champion strategy's weights (true) or the fallback
--                          profile weights (false) — so a score jump right after a
--                          weight promotion is attributable to the learning loop.

alter table signal_score_history add column if not exists rationale text;
alter table signal_score_history add column if not exists research_packet_id uuid;
alter table signal_score_history add column if not exists used_champion_weights boolean;
