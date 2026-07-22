# Feature: Research Journal Controls and Market-Local Clocks

**Status:** SHIPPED
**Owner:** Vaibhav
**Date:** 2026-07-21

## Intent

- Score Tracker must support clearing all selected symbols.
- Its existing point filters must also identify matching symbols across the
  bounded candidate universe, with explicit commands to select or add those
  matches to the chart.
- Daily Funnel must support one-date and all-date views plus a symbol filter.
- The persistent US and India status pills must show each market's current local
  time in addition to the existing session state and open/close schedule.

## Contracts

### Score Tracker

- Candidate symbols remain the current market's watchlist/holdings/custom set.
- Candidate discovery and persisted chart selections are market-scoped. The US
  live-portfolio endpoint is never used to populate India's picker.
- Filter matching queries `signal_score_history` through the existing owner-only
  endpoint, in chunks of at most 50 symbols. It does not call a provider.
- A symbol matches when at least one stored score point satisfies the current
  period, score-band, direction, source, and date filters.
- Active filters narrow the displayed symbol chips. They never silently change
  chart selection. `Select filtered` replaces selection, `Add filtered` unions
  matches into selection, and `Clear selection` removes every chart line.
- The global market switcher remains the sole US/India authority.

### Daily Funnel

- Default remains one market-local date and the latest decision per symbol for
  that date.
- `All dates` returns at most the 250 newest immutable observations for the
  selected market, or for one validated symbol when filtered. The response marks
  truncation honestly; it never claims unbounded completeness.
- Symbol filtering is server-side and exact after trim/uppercase normalization.
- Each all-date card is keyed by observation ID and shows its market-local date,
  so repeated observations for one symbol remain distinct and expandable.
- Existing stage, paper/live position, outcome, evidence, and terminal-state
  joins remain display-only.

### Market Header

- US displays current `ET`; India displays current `IST`.
- Existing status label and schedule detail remain visible.
- Time updates every 30 seconds and uses IANA time zones; no fixed UTC offsets.

## Non-Goals

- No score recalculation, signal selection, provider call, order, portfolio, or
  risk behavior change.
- No cross-market chart or journal result.
- No unbounded historical read or infinite-scroll build in this phase.
- No new database table, migration, package, or scheduled job.

## Acceptance

- Clear selection produces an empty chart state.
- Filter matching is computed over candidates that were not previously selected.
- Select/add filtered affects only the current market.
- All-date Daily Funnel can show multiple observations for one symbol and states
  the 250-row bound.
- Desktop and 390px mobile layouts contain all controls without overlap.
