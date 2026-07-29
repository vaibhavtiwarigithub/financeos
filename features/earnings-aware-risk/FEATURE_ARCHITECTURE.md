# Feature Architecture: Earnings-Aware Risk

## Status

Architecture status: Approved P0 - implemented 2026-07-29
Architecture approved: Yes
Approved scope: Measure-only US paper/live annotations, India proximity,
display-only holding warnings, normalized append-only evidence
Implementation allowed: P0 only

No behavioral policy is approved. `block` and `size_down` remain unavailable.

## Decision

Use earnings proximity and an options-derived move proxy as **risk context**, not
as a sixth alpha score.

Build the first release as measure-only:

- US paper: annotate every otherwise-eligible entry.
- US live: annotate, while preserving the existing Alpha Vantage earnings
  blackout exactly as-is.
- India: annotate earnings proximity when available; options risk is
  `unavailable`.
- Existing positions: surface a warning only. PositionMonitor and live exits do
  not change.

No block, size reduction, stop widening, score change, promotion input, or
automated exit is allowed until the shadow record passes the acceptance gates in
this document and the owner separately approves the behavior.

## Why This Belongs In Risk, Not Alpha

Short-dated option prices around a known earnings event contain information about
the market price of uncertainty. They do not provide a reliable sign for the
stock's next move. Skew and flow may contain directional information in some
settings, but retail-visible volume cannot reliably identify opening versus
closing trades, buyer versus seller initiation, or multi-leg hedges.

Kairos may therefore use:

- earnings timing as event-risk metadata;
- a same-expiry ATM straddle as an expiry-bounded move proxy;
- the ratio of that proxy to the planned stop distance as context.

Kairos must not use:

- put/call ratio, "unusual calls", or skew as automatic long conviction;
- the move proxy as a directional forecast;
- options fields in `analyst_score` or the LearnerAgent objective.

This feature does not need directional IC validation because it makes no
directional alpha claim. It **does** need operational and calibration validation:
coverage, quote quality, date accuracy, implied-versus-realized move calibration,
and counterfactual effects on entries and outcomes.

## Verified Current State

| Area | Current behavior |
|---|---|
| US PaperTrader | No earnings gate or annotation at the fill choke point |
| US TraderAgent | Already blocks proposals from 2 calendar days after through 5 calendar days before an Alpha Vantage earnings date |
| Existing live gate | Fetches Alpha Vantage directly, fails open on timeout/unavailable data, and is not shared with PaperTrader |
| `lib/data/earnings.ts` | Finnhub US and Yahoo India proximity helper; returns days only and loses source/as-of/confidence metadata |
| `lib/data/earnings-pit.ts` | Captures point-in-time earnings vintages |
| `lib/options-signal.ts` | On-demand Yahoo nearest-expiry chain; not on a trading path |
| Current `ivPercentile` | Not a 52-week IV percentile. It locates ATM IV inside the current chain's strike-IV range |
| Current unusual-flow labels | Comments and summary overstate contracts as "smart money" evidence |
| Paper audit | `pipeline_stage_events` records stage decisions |
| Live audit | `trade_proposals.risk_check_reasons` records proposal risk checks |

The new feature must not accidentally replace or weaken the existing live
blackout. A unified policy can replace it only after shadow coverage parity and
an explicit owner-approved cutover.

## Verified Broker Data Surfaces

The connected broker surfaces were re-probed on 2026-07-29. Availability is
useful, but tool presence alone is not evidence that a field is correctly
timestamped, complete, or stable enough for a money-path decision.

| Source | Earnings | Options | Verified state | Intended role |
|---|---|---|---|---|
| Finnhub | Yes | No | Existing US `fetchDaysToEarnings()` source | Current US calendar source and independent fallback |
| Alpha Vantage | Yes | No | Existing live TraderAgent blackout source | Preserve until unified resolver proves parity |
| Webull MCP | Yes | No | Live `tools/list`: 71 tools. `get_stock_earnings_calendar` returned AAPL dates, actual/estimated EPS, and actual/estimated revenue | US earnings-date cross-check and optional estimate context |
| Robinhood MCP | Yes | Yes | Live `tools/list`: 52 tools, including `get_earnings_calendar`, `get_earnings_results`, `get_option_chains`, `get_option_quotes`, and `get_option_historicals` | Candidate broker-backed earnings cross-check and preferred US options source after payload probe |
| Yahoo | Yes for India; US fallback possible | Yes | Existing India calendar helper and current on-demand US options implementation | India calendar source; shadow-only US options fallback |

Webull's published Cloud MCP surface does **not** expose an equity-options chain,
despite exposing stock quotes and many fundamentals tools. Do not infer options
support from Webull's brokerage product or separate trading documentation.

Robinhood is the strongest candidate for the US move proxy because the connected
MCP advertises contract discovery plus current quotes. Before selection as a
provider, an owner-run allowlisted probe must verify:

- exact expiry and strike fields;
- same-contract bid, ask, sizes, timestamp, and open interest;
- whether quotes are real-time, delayed, indicative, or entitlement-dependent;
- response pagination and maximum contracts per request;
- behavior outside market hours and for illiquid names;
- rate limits and token/session failure behavior.

Broker OAuth calls do not consume Finnhub, Alpha Vantage, or Yahoo quotas, but
they are not quota-free by assumption. They require independent pacing,
provider-call accounting, caching, and health monitoring. A disconnected broker
must become `unavailable`; it must never silently change entry behavior.

### Source resolution

Earnings dates should be prewarmed and resolved from the existing point-in-time
calendar cache rather than fan-out to three providers synchronously at every
entry. Finnhub, Webull, and Robinhood observations retain source and as-of
metadata. A disagreement beyond one market session is `conflict`, not a majority
vote.

For US option snapshots:

1. Robinhood is the preferred candidate only after its payload probe passes.
2. Yahoo remains a shadow-only fallback with an explicit unofficial-source tag.
3. Webull returns `unsupported`, not `unavailable`, for options.
4. No broker order or option-order tool is used. Read and execution allowlists
   remain separate.

## Risk Contract

### Earnings event

```ts
type EarningsEventRisk = {
  market: "us" | "india";
  symbol: string;
  reportDate: string | null;
  reportSession: "bmo" | "amc" | "during_session" | "unknown";
  sessionsUntilReport: number | null;
  source: string | null;
  observedAt: string;
  confidence: "confirmed" | "estimated" | "unknown";
  status: "available" | "unknown" | "conflict";
};
```

Calendar sessions, not UTC duration or raw calendar-day subtraction, determine
proximity. If sources disagree beyond one market session, status is `conflict`;
the system must not silently choose the more convenient date.

### Options move proxy

```ts
type EarningsMoveProxy = {
  market: "us";
  symbol: string;
  observedAt: string;
  quoteAsOf: string | null;
  reportDate: string;
  reportSession: EarningsEventRisk["reportSession"];
  expiry: string;
  spot: number;
  strike: number;
  callBid: number;
  callAsk: number;
  putBid: number;
  putAsk: number;
  callMid: number;
  putMid: number;
  moveProxyPct: number;
  stopDistancePct: number | null;
  stopToMoveRatio: number | null;
  quality: "usable" | "wide_spread" | "stale" | "illiquid" | "unavailable";
  reason: string;
};
```

The calculation is:

```text
moveProxyPct = (ATM call mid + ATM put mid) / contemporaneous spot
```

It is labelled **expiry-bounded ATM straddle move proxy**, not "earnings implied
move". The premium contains event variance, non-event variance through expiry,
volatility risk premium, rates/dividends, and bid/ask effects.

## Deterministic Chain Rules

1. Select the earliest standard expiry that is after the earnings event and
   leaves at least one tradable post-event session. Account for BMO versus AMC;
   unknown timing makes the proxy lower-confidence.
2. Fetch that exact expiry. The current Yahoo call only reads `options[0]` and
   is insufficient.
3. Select the nearest strike present in both calls and puts.
4. Use mids only when both bid and ask are finite, non-negative, and ask is not
   below bid. Last trade is never a substitute.
5. Require a configurable maximum spread-to-mid ratio on each leg, nonzero open
   interest or quoted size, a fresh quote timestamp, and a contemporaneous spot.
6. Reject crossed, stale, zero-premium, missing-leg, or implausible results.
7. Cache the raw normalized snapshot by `(symbol, expiry, observed market
   session)`. Never overwrite a snapshot used by a decision.
8. Every provider is fail-soft and source-labelled. Robinhood requires an
   allowlisted payload probe; Yahoo is unofficial and remains a shadow fallback.
   A capability probe and provider-health metric are required before shadow
   runs.

The first build must rename or remove the current `ivPercentile` label and remove
"smart money" claims from unusual-flow summaries. Neither field is part of this
feature's decision contract.

## Policy

```ts
type EarningsRiskPolicy = {
  version: number;
  mode: "shadow" | "block" | "size_down";
  market: "us" | "india";
  proximitySessions: number;
  maxLegSpreadToMid: number;
  maxQuoteAgeSeconds: number;
  minOpenInterest: number;
  sizeMultiplier: number;
};
```

Initial production configuration is permanently pinned to `shadow` until an
owner-approved migration/config change activates another mode.

`earningsRiskVerdict()` is pure and deterministic. It may only preserve or
reduce entry eligibility/size. It can never:

- increase a score, size, price target, or holding horizon;
- widen or remove a stop;
- suppress a sell or any PositionMonitor/live-exit action;
- convert unknown data into "no earnings";
- borrow US options evidence for India.

In shadow mode, unavailable data records `unknown` and does not block. In a
future active mode, unavailable behavior must be decided explicitly; it cannot
inherit a generic fail-open default.

## Money-Path Integration

### Paper

Run the pure verdict after the fill-bound stop/target plan exists and before the
atomic `execute_paper_fill` call. In P0, only log the counterfactual verdict to
`pipeline_stage_events`; do not alter the RPC inputs or claim lifecycle.

Capital rotation must use the same annotation contract. A rotation cannot bypass
measurement merely because it enters through the slot/cash replacement path.

### Live

Run the shared annotation before proposal insertion and persist it inside
`trade_proposals.risk_check_reasons`.

The existing Alpha Vantage `-2/+5` blackout remains authoritative during P0.
The new resolver must not catch an error and skip that existing gate. Replacement
requires:

1. coverage parity over predeclared observations;
2. no regression in known-date blocking;
3. an owner-approved policy version;
4. one atomic cutover that removes the direct Alpha Vantage path.

Autonomous live execution must re-check the persisted policy version and verdict
freshness before submitting an approved proposal, just as it re-checks other
latched money-path controls.

### Existing positions

P0 may show:

- earnings date/session;
- sessions remaining;
- usable move proxy;
- stop-to-move ratio;
- data-quality state.

It must not cause PositionMonitor or the live exit monitor to trim, close, move a
stop, or alter a target. Gaps can jump resting or synthetic stops, so
`stopToMoveRatio < 1` is a warning, not proof that the stop is wrong.

## Persistence And Provenance

Do not create a parallel evidence truth layer.

- Source payload/fingerprint references use existing `evidence_records`.
- Paper decision context uses `pipeline_stage_events.detail`.
- Live decision context uses `trade_proposals.risk_check_reasons`.
- If cross-flow analytics cannot be made reliable over those ledgers, add one
  append-only `earnings_risk_observations` table only after schema approval. It
  must reference the existing signal, paper event/proposal, evidence record,
  policy version, and source snapshot rather than duplicating source truth.

No raw option chain is exposed to the browser. Owner-facing APIs return only the
normalized fields above. RLS is owner-read; writes are service-only and
append-only.

## Shadow Metrics And Acceptance Gates

Predeclare the shadow window before collecting outcomes. Minimum gates:

1. At least 60 otherwise-eligible US entry decisions and at least 20 distinct
   earnings events.
2. Earnings-date coverage at least 95% for symbols where the legacy live gate
   found a date.
3. Date disagreement, reschedule, and unknown rates reported separately.
4. Usable option snapshot coverage reported by liquidity tier; no silent
   exclusion of thin names.
5. Compare proxy with absolute close-to-close and close-to-next-open event moves.
6. Report empirical exceedance rates for `0.5x`, `1.0x`, and `1.5x` proxy bands.
7. Counterfactual report: entries blocked/sized down, later P&L, MAE/MFE,
   stop-outs, and sample sizes. No claim based only on average P&L.
8. No paper/live eligibility or size change while mode is `shadow`.

These observations test calibration and product usefulness, not directional IC.
A future block/size-down proposal must specify its expected trade-count cost and
must default to no change when evidence is inconclusive.

## Build Order

1. Correct misleading existing option labels and add golden parser tests.
2. Add bounded read-only Robinhood earnings/options contract probes and persist
   only schema fingerprints plus normalized test results.
3. Add Webull earnings into the source-aware, session-aware earnings-event
   resolver; retain Finnhub/Alpha Vantage observations through cutover.
4. Add exact-expiry Robinhood fetch, Yahoo fallback, and pure
   quote-quality/move-proxy calculation.
5. Add pure `earningsRiskVerdict()` with `shadow` as the only enabled mode.
6. Wire paper, rotation, and live annotation without changing behavior.
7. Add owner-facing Backtest/Risk visibility and provider-health coverage.
8. Accumulate the predeclared shadow record.
9. Review evidence and separately decide whether to keep annotation-only,
   activate bounded size-down, or reject the behavioral feature.

## Tests Required Before P0 Ships

- BMO, AMC, unknown timing, weekend, holiday, and rescheduled event cases.
- Exact expiry selection and same-strike call/put pairing.
- Missing leg, zero bid, crossed quote, stale quote, wide spread, and no-OI cases.
- US/India isolation.
- Paper fill and capital-rotation paths both produce annotation.
- Existing live blackout still blocks every case it blocked before.
- Annotation failure cannot alter eligibility, sizing, or exits.
- Idempotent retries do not create conflicting observations.
- Browser payload excludes raw chain data.

## Sources

- Cboe explains that short-dated options around earnings primarily indicate the
  magnitude, not direction, of the expected reaction and compares straddle
  pricing with historical moves:
  https://www.cboe.com/insights/posts/what-options-data-may-indicate-about-mag-7-earnings
- Chung and Louis document that earnings-event option returns and implied versus
  realized volatility vary with pre-event conditions, which is why calibration
  cannot be assumed:
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2886040
- SEC material notes that disseminated option quotes can be stale during market
  data stress, supporting explicit freshness and quote-quality gates:
  https://www.sec.gov/rules-regulations/2001/09/firm-quote-trade-through-disclosure-rules-options

## Owner Decision

Recommended approval, when requested:

- P0 measure-only implementation;
- US paper + US live annotation;
- India proximity annotation only;
- existing live blackout preserved;
- existing positions display-only;
- no scoring, sizing, entry, stop, target, or exit behavior change.

Do not approve `block` or `size_down` yet.

## P0 Implementation Result

Implemented in `lib/risk/earnings-risk.ts` and recorded in
`IMPLEMENTATION_RESULT.md`. Production is pinned to policy version 1
`mode='shadow'`; the database rejects any other mode and rejects
`behavior_changed=true`.
