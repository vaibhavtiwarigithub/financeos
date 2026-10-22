# Recent qualified candidates

Status: owner approved the five-session / 20-name plan on 2026-10-21; implementation and local/database verification complete, production deployment verification pending.

## Why and scope

Research can identify a qualifying entry when neither paper nor live has capacity.
The execution signal must expire, but that must not erase the reason to reconsider
the symbol. Keep one bounded, shared research shortlist per market, not another
scoring engine. This is a research-priority change, not a new trading permission.

## Contract

- Retain ordinary US/India equity and ETF candidates for five regular market
  sessions INCLUDING original qualification; at most 20 active names per market.
- Exclude leveraged funds and crypto (their own session/quote policies apply).
- A service-only RPC serializes market writes, preserves first signal/score/session,
  and updates latest signal/score/source without moving expiry. Newer disqualifying
  research invalidates the episode. Neither high-score refresh nor expiry restarts
  an episode: renewed admission needs a disqualifying observation followed by a
  genuinely new qualification. Keep closed episodes as audit history.
- Only validated deterministic research with the existing entryEligible predicate
  may admit a name. Preserve original discovery source, not a fabricated source.
- Admission means research-qualified, NOT quote/broker/risk/order eligible. Current
  mandate, risk geometry, broker support, quote freshness, cash and all gates remain
  the responsibility of existing executors.
- Rank retained names by latest score, not historical peak. Refresh oldest first
  within a bounded five-name research lane; merge fresh results with ordinary new
  discoveries and held-name top-ups through existing execution selection.
- The existing scheduled research producer refreshes the lane daily. Entry attempts
  with available capacity can also request bounded refresh work; atomic leases and
  per-session attempts prevent duplicate expensive work. Never call a trading route
  from the refresh worker. Failures surface in System Health and remain needs-refresh.
  If batch-relative rank gating is enabled, use the scheduled full-cohort run;
  an isolated refresh cannot bypass that gate. An unreadable rank policy fails
  closed for isolated refresh, not for the independent ordinary research producer.

## Data and reuse

Add `recent_qualified_candidates` (episode rows, first/latest signal FKs, scores,
market sessions, source, state, optional refresh lease) plus service-only recorder
and claim RPCs. Enable RLS; no anonymous access or client writes; owner-only reads
through the existing owner guard. Migration is additive and must be verified before
runtime deployment. Existing signal rows, score history, pipeline_stage_events and
paper_missed_opportunities remain the provenance/outcome ledgers; do not rewrite
them or select candidates using later realized returns.

Implementation locations: `lib/research/recent-candidates.ts` (calendar/lifecycle
projection and persistence), research-agent scheduler/writer, bounded refresh service,
paper/autonomous-live entry callers, owner shortlist API, a shared portfolio panel,
tests and architecture chapters. No package additions or strategy/threshold changes.

## UI

Both paper and live portfolio pages use the same compact "Candidates waiting"
panel per selected market. Show original/latest score, last assessment, retention
remaining, research state and most recent market/book-specific decision reason.
Make stale, unknown, held and blocked states explicit. No Buy button or claim that
the name is a known winner. Layout follows existing T tokens and native disclosures.

## Verification

Test holiday/weekend and year-boundary fail-closed calendar behavior; fixed expiry;
score downgrade; invalidation; cap/concurrency; exclusion; freshest score ordering;
lease deduplication; source preservation; owner authorization; US/India parity;
expired signals never revived; existing execution risk and live-enable controls
unchanged. Verify persisted lifecycle in a rollback-only synthetic DB transaction,
plus production read-only API/UI on the deployed commit. Do not manufacture orders
to demonstrate a fill. Actual retention benefit requires forward paired evaluation
against the current workflow, costs and drawdown; no P&L superiority claim on ship.
