# US Policy Event Ledger

## Decision

Build a US-only, record-only FOMC ledger so Kairos can distinguish a scheduled
Fed decision, the pre-decision market expectation, the realized target range,
and later observed symbol/benchmark returns. The existing MacroSentinel remains
a slow US macro regime. This feature is not a score, trade, sizing, or exit input.

## Sources And Boundaries

- **Official outcome:** FRED `DFEDTARL` / `DFEDTARU`, whose source is the Federal
  Reserve and whose observations are the effective target range. A scheduled
  event is marked decided only after both ranges are observed after its date.
- **Expectation:** immutable snapshots are supported, but no source is enabled.
  CME's supported FedWatch API is paid; do not scrape the public webpage or
  fabricate probabilities. A future licensed adapter writes only pre-decision
  snapshots with source URL, source name, and capture time.
- **Impact:** compound only rows already present in `symbol_daily_returns`.
  No event route fetches quotes or candles, so it cannot consume research API
  quota or cause a late provider revision to masquerade as a decision-time fact.
- **Scope:** US FOMC only. India receives no Fed score, event, or inferred RBI
  substitute. A separate RBI design is required later.

## Data Model

1. `policy_rate_events`: one mutable schedule/outcome row per FOMC date.
2. `policy_rate_expectation_snapshots`: append-only pre-event expected ranges.
3. `policy_event_impacts`: append-only 1D/5D raw and SPY-relative returns.

An impact row includes an input fingerprint and its available time. It can be
recomputed when more frozen daily-return data exists, but it never overwrites a
previous calculation. Raw symbol returns may be recorded without a benchmark;
SPY-relative excess stays null until identical frozen benchmark sessions exist.

## Operation

`POST /api/agents/policy-events` is a daily server-only job. It upserts the
official calendar, reads FRED target ranges, resolves past scheduled outcomes,
and derives impacts from existing US daily-return evidence. It does not invoke
ResearchAgent or an LLM. The read API powers the Markets card.

## Acceptance Criteria

- A public/anonymous client cannot read or write ledger tables.
- An expectation after the decision is rejected; a missing expectation renders
  as unavailable, never zero or “hold expected.”
- FRED failures preserve existing records and produce no invented decision.
- Event impacts require complete 1D/5D sessions and calculate excess only when
  both symbol and SPY returns are comparably available.
- No scorer, trader, PaperTrader, PositionMonitor, or broker adapter imports
  the ledger.
