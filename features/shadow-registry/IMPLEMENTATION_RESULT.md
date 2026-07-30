# Shadow Registry and Upgrade Path - Implementation Result

Date: 2026-07-29
Status: COMPLETE

## Shipped

- Owner-only `/dashboard/upgrade-path` page in the Research navigation.
- Typed registry covering 10 data, scoring, trading, risk, portfolio, and
  learning programs.
- Live adapters over existing evidence ledgers; no parallel evidence table.
- Lifecycle, benefit, market, schedule, progress, collection-rate, provider-call,
  blocker, safety-boundary, next-action, and defensible-ETA reporting.
- 60-second page refresh plus manual refresh and lifecycle filters.
- DashboardShell's US/India switch is authoritative. Every ledger query and
  derived metric is scoped to that market; unsupported programs remain visible
  as `Not applicable`.
- Service-only `get_shadow_cron_status()` RPC.
- Removal of the zero-output `kairos-shadow-us` and `kairos-shadow-india`
  recurring jobs. Their routes remain available for a future approved campaign.
- Owner authentication and symbol validation on `/api/options/signal`.
- Removal of options-flow content from ResearchAgent prompts. Options remain
  outside `analyst_score`; earnings options remain event-risk shadow evidence.

## Production Verification

- Migration `20260729210000_shadow_registry_cron_status.sql` applied.
- RPC is security-definer with fixed `search_path`; only `service_role` can
  execute it.
- Router shadow/cohort, EdgeScout/IC/readiness, earnings PIT, international
  allocation, validation sweep, and downside-hedge schedules remain present.
- Autonomous live remains a separate fail-closed path and was not enabled.

## Gates

- TypeScript: passed.
- Vitest: 1,421 passed, 7 skipped.
- Next.js production build: passed; page and API included.
- Registry governance tests: 5 passed.

## Reversal

Remove the read-only page/API/registry and reschedule the two autonomous-shadow
jobs only if a new owner-approved evidence campaign declares a target, budget,
and review gate. No position, cash, score, strategy, or evidence row requires
rollback.
