# ETF constituent coverage and complete rotation source assessment

Status: owner requested implementation on 2026-10-21; implementation and source contracts verified, production release pending.

## Why, who, expected benefit

Kairos's owner needs benchmark-leading companies to enter research and capital
rotation to consider every legitimate funding holding. Expected benefit is better
coverage and fewer false rejections; no return advantage is presumed. ShippedAt:
pending production verification.

## Existing owners and extension

- `lib/nifty50-constituents.ts`: reuse CSV validation, generalizing the expected
  count for the official IT, Bank and Next 50 index lists. Preserve the NIFTY-50
  exact-50 public contract.
- `lib/research/etf-constituents.ts`: new source adapter because no existing module
  reads issuer fund holdings. Invesco supplies QQQ JSON; SPDR supplies daily
  XLSX (bounded XML extraction using existing fast-xml-parser and Node zlib).
  VOO uses SPY's S&P 500 constituents as an explicitly labelled membership proxy.
  India uses underlying index lists, not fabricated ETF weights.
- `gatherSymbols`, existing research queue and caps: four US discovery candidates
  and up to three of India's existing five index-reserve seats consider verified
  benchmark constituents. Holdings and manual owner requests retain priority.
  Sources are the existing enabled benchmark registry. Current eight benchmarks
  are covered. Metal bars, futures and bond funds are not equity baskets.
- Existing `features.discovery` stores membership source, observed date, source
  as-of date, proxy status and completed-session benchmark momentum. Current
  membership must never be applied retroactively to a historical replay.
- Existing `recordCapitalRotationShadow`: read complete score/lot/return cohorts,
  then evaluate every holding under the same P1 contract. Choose the weakest
  feasible fully qualified source. If none qualifies, retain an explicitly
  blocked diagnostic; persist every source's reasons. The existing paper
  portfolio activity panel renders those alternatives in both markets.

## Admission and failures

Membership is researched, never an automatic buy. Oldest research first within
each basket, with two stale constituents from the strongest measured five-session
basket first, then round-robin across all baskets. Freshness uses only completed
market sessions. A stale or missing benchmark return produces no leadership
claim. Downloaded holdings must be dated, non-future, no older than ten calendar
days; NSE's undated current file is stamped observed-current, not historical.
Duplicate, malformed and incomplete lists fail visibly through System Health.
Source responses are cached for one day. No new cron, table, API route or package.

Candidate caps and wall-clock budget still bound throughput. This does not claim
daily deep research of all 500+ S&P names; the queue rotates. Nor does it guarantee
participation in every future rally. Broad constituent coverage remains distinct
from complete price history and trade eligibility.

## Rotation invariants

Preserve atomic sell/buy and exact quantities; current score freshness; target and
stop/exit precedence; eight-name and configured sector/gross limits; persistence;
turnover; reconciled lots; independent correlation; and validated positive net
economic evidence. No score threshold, weight, margin, model, flag, position or
live-order setting changes. Future price gains cannot be used to select today's
source or silently turn a negative/insufficient mapping into a pass.

## Acceptance

1. Read all eight configured benchmark baskets from real public endpoints.
2. Unit checks reject partial/duplicate membership; rotate and deduplicate names.
3. A P1-blocked weakest source cannot hide another fully qualified replacement.
4. When all sources fail, all failures remain blocked and visible.
5. Typecheck, existing research/rotation regressions and production build pass.
6. Confirm deployment; next natural research/rotation run must carry new
   provenance/alternative evidence before collection is called verified live.

## Sources

- https://www.niftyindices.com/indices/equity/sectoral-indices/nifty-it
- https://www.ssga.com/us/en/individual/etfs/state-street-technology-select-sector-spdr-etf-xlk
- https://www.invesco.com/qqq-etf/en/about.html
