# Property Stage 3 — ZIP-Level Area Context

## Status

Implemented 2026-09-08. Owner-approved 2026-09-08.

## Problem

Property Stage 1/2 give metro- and county-grain market context (FHFA, FRED,
BLS, HUD, Census ACS) and owner-entered per-property value evidence
(`property-value-intelligence`). Neither answers "what is the ZIP this
property actually sits in doing?" — the grain a home owner actually thinks
in.

## Product decision

Add one more free, keyless, official source — **Zillow Research ZHVI**, ZIP
grain — as a strictly separate **area context** series next to each tracked
property's own recorded value. It must never be blended in.

### Honesty constraint (hard requirement)

Per Zillow's own [ZHVI User Guide](https://www.zillow.com/research/zhvi-user-guide/),
ZHVI is a smoothed, seasonally-adjusted weighted average of the **middle
third** of homes in a region. It is:

- NOT this property's value
- NOT an AVM or Zestimate substitute
- NOT ever written into, or used to derive, the owner's recorded `value`

The UI (`components/property/ZipAreaTrend.tsx`) renders it as a clearly
labelled, visually separate block: level, 3M/12M change, as-of date, source
name/link, and an explicit "why this is separate" line. No LLM path reads
or summarizes this table.

## Data flow

```
Zillow Research ZHVI (ZIP CSV, ~120MB, no key)
  -> ZillowZhviZipAdapter (lib/property/sources.ts)
     filters to Metro ~ Austin-Round Rock / Phoenix-Mesa, last 13 monthly cols
  -> POST /api/property/collect (existing weekly kairos-property-collect cron,
     no new schedule — ZHVI's monthly release is polled weekly; idempotent)
  -> property_zip_observations (new table, append-only, migration
     20260908120000_property_zip_zhvi_observations.sql — applied + verified)
  -> GET /api/property/zip-trend?market=&zip= (new, owner-gated)
  -> components/property/ZipAreaTrend.tsx, rendered per property row in
     MyPropertiesWorkspace.tsx keyed off the property's own postal code
```

## Why reuse the existing adapter/cron pattern

`lib/property/sources.ts` already runs four keyless US adapters
(FHFA/FRED/BLS/HUD) on one weekly collector with a per-invocation fetch
cache and a `property_source_runs` ledger. `ZillowZhviZipAdapter` follows
the same `supportsMarket` / `fetch` shape and the same
`PropertySourceUnavailableError` contract, so a Zillow outage or format
change reports as a typed `unavailable`/`failed` run row — never a silent
empty dataset. It rides the same cron rather than getting a new one because
the system-map convention is to extend an existing scheduled-flow node when
a source joins the flow it already belongs to, not fork a near-duplicate.

## Deliberately left out

- **No new cron.** Weekly polling of a monthly-updated source is the same
  pattern already used for BLS (monthly) and HUD (annual) on this cron.
- **No full ZHVI history.** Only the trailing 13 monthly columns are kept
  per run (enough for a 3M/12M trend); a longer chart is a future ask, not
  this one.
- **No streaming parser.** The adapter downloads the full ~120MB CSV via
  the existing `fetchText` cache and filters in memory. Ceiling: if this
  times out or exceeds function memory in production, upgrade to a
  streaming line-filter (flagged with a `ponytail:` comment at the call
  site) — not built preemptively.
- **No India/Bengaluru coverage.** Zillow does not publish ZHVI outside the
  US; `supportsMarket` returns false for `bengaluru`, matching every other
  US-only adapter's `not_applicable` (not empty-success) reporting.
- **No AVM, no Zestimate, no blended "estimated value."** Explicitly out of
  scope by the honesty constraint above.
