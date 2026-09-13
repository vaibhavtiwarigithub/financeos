# Broker-Compatible US Research Universe — Readiness Audit

**Date:** 2026-09-13
**Scope:** approved broad-US research-universe Stage 0 prerequisites only.
**Authority:** [`features/broker-compatible-research-universe/FEATURE_ARCHITECTURE.md`](../../features/broker-compatible-research-universe/FEATURE_ARCHITECTURE.md) remains **proposed, architecture only**. This audit authorizes no migration, collection, research expansion, router change, score change, order, or broker activation.

## Verdict

**Stage 0 is not ready to graduate to catalog/schema work.** A small, bounded
capability-and-source study can be built only after a narrow contract-reconciliation
decision. The system has useful pieces, but none of the architecture's required
source, capacity, or broker-probe evidence has been collected as a governed program.

The most important finding is a code/evidence contradiction:

| Claim | Evidence | Meaning |
|---|---|---|
| Robinhood MCP exposes `get_equity_tradability` | Latest production capability snapshot, 2026-09-06, lists 73 tools including `get_equity_tradability`, `search`, `run_scan`, and `get_scanner_filter_specs` | The architecture's correction that an instrument-capability tool exists is supported. This is not proof of the tool's input/output contract or bulk-enumeration capability. |
| Kairos can perform a Robinhood symbol preflight | `lib/brokers/adapters/robinhood-mcp.ts` returns `unsupportedCapability(..., "mcp_has_no_instrument_capability_tool")` unconditionally | False today. Every Robinhood preflight is denied, so no candidate probe or last-mile tradability evidence can be produced through this adapter. |
| Production has useful candidate-probe evidence | Read-only production query found **zero** rows in `broker_instrument_preflights`; `listing_candidates` and `issuer_filings` are also empty | There is no measured pass/deny rate, TTL, lot-size/fractional behavior, or broker-account corroboration. |

The production tool inventory is also stale for a safety contract: the latest snapshot
is seven days old and the current cron is weekly. It records only names and a schema
fingerprint, not the schema needed to safely map a side-specific probe.

## Prerequisite audit

| Required prerequisite | Current evidence | Status |
|---|---|---|
| Current exchange/reference catalog source | No `us_instrument_catalog`, source-policy, or membership migration exists. No retained raw directory manifest or licensing record exists. | **Blocked** |
| NYSE/NYSE Arca coverage and terms | No selected source or documented retention/license decision. Nasdaq-only would not meet the broad-US claim. | **Owner/data blocker** |
| Stable identity reconciliation | Existing `symbol_profiles` and `instrument_registry` are ticker/symbol-oriented research helpers. No immutable catalog identity/event contract exists. | **Blocked** |
| Classification quality study | Production baseline remains 50/167 observed US decision symbols without a sector. Finnhub `profile2` is a display/context source, not a verified canonical taxonomy. No stratified coverage/TTL/conflict measurement. | **Blocked** |
| Price and liquidity coverage/capacity | The PIT resolver can calculate a **mean** 20-session dollar volume for a historical US factor cohort only within Massive's roughly two-year grouped-bar entitlement. It has neither the architecture's current catalog source nor its required median-dollar-volume arms ($2m/$5m/$10m), provider-cost measurement, or daily cohort budget. | **Blocked** |
| PIT / survivorship discipline | `lib/edges/pit-universe.ts` is soundly fail-closed for the Edge lab: date-specific membership, 20 complete daily windows, no fallback, and refusal outside entitlement. It is not the proposed research measurement universe and must not be repurposed silently. `lib/edges/universe.ts` and relative-strength discovery remain current-liquid/static and survivorship-biased. | **Partially reusable, not sufficient** |
| Broker candidate probes | The append-only ledger and `purpose='candidate_probe'` discriminator were deployed, correctly separated from `execution_attempt`. There are zero rows, and the Robinhood adapter cannot create an affirmative result. | **Blocked by contract implementation** |
| Existing daily discovery evidence | `gatherSymbols()` remains a bounded queue of holdings, opted-in watchlist, Yahoo value/growth buckets, curated baskets, India screener, and static-universe Edge relative-strength names. The research cron preserves/re-defers provenance and reports budget deferrals. This is operational candidate discovery, not a representative US measurement cohort. | **Exists, unsuitable as control universe alone** |
| Family-router shadow | No catalog/membership, shortlist-assessment, or router-arm persistence exists. Current Yahoo buckets are two static common-equity screens; the relative-strength feed's static list is explicitly not PIT. | **Not built** |

## What can safely be built now

Only the following **read-only Stage 0 study**, still evidence-only and with no
schema migration, may proceed once the Robinhood contract discrepancy is resolved:

1. A bounded report parser for Nasdaq listed/other-listed directory samples, with
   raw hashes, parser outcomes, duplicate/test-issue handling, timestamps, and an
   explicit `unavailable` state. It must not call the result a complete US catalog.
2. A stratified sample study of current common-stock identity, sector classification,
   daily-bar availability, and trailing-liquidity coverage for the three predeclared
   dollar-volume arms. Store/report only the study result, not a membership snapshot.
3. A source contract comparison that names the NYSE/Arca coverage gap, data-retention
   permission, price-provider cost/rate budget, and a selected identity authority.
4. A Robinhood *schema inspection* that captures the exact live input schema for
   `get_equity_tradability` and tests pure parsing against fixtures. A live candidate
   probe must remain disabled until its required fields, account scope, side semantics,
   TTL, and response guarantees have been reviewed.

These are implementation-ready only as a separately approved Stage 0 scope. They
do not justify applying the Stage 1 schema described in the architecture.

## What cannot be built safely yet

- `us_instrument_catalog`, `universe_memberships`, or a daily snapshot: no chosen
  source contract, licensing decision, classifier quality threshold, liquidity policy,
  or capacity budget exists.
- A broker-compatible label: a tool name is not a tradability result, and no supported
  Robinhood adapter maps or validates it.
- A broad-family router / shortlist shadow: its input population and liquidity-only
  control do not yet exist.
- Any historical performance conclusion from today's Nasdaq/Robinhood catalog: both
  would recreate survivorship bias.
- Any change to `research_enabled`, paper eligibility, or broker/live execution.

## Required decisions and next sequence

1. **Owner decision:** approve the four-part Stage 0 study above, and state whether
   current common equities only remains the first cohort (recommended) or whether ETF
   study is funded as a separate simultaneous cohort.
2. **Engineering correction before probes:** reconcile the Robinhood capability
   inventory with `robinhoodMcpAdapter.preflightOrder`. Implement no live enablement;
   first capture the exact tool schema and add fixtures proving a missing/ambiguous
   schema fails closed.
3. **Source decision:** select/approve a legally retainable NYSE/Arca-inclusive
   source route or explicitly narrow the claim to a documented, incomplete cohort.
4. **Only after measured Stage 0 output:** freeze catalog source, classification
   standard, liquidity/minimum-price policy, and daily deterministic budget; then
   submit the Stage 1 migration plan for owner approval.

## Non-claim

The installed PIT factor machinery does not prove the broad-US research program is
ready. It is constrained to an approximately two-year historical entitlement and
uses a different policy lifecycle. The deployed preflight ledger does not prove
broker readiness because it contains no observations. The current screens continue
to be useful bounded candidate sources, but they do not establish broad-market
coverage or alpha.
