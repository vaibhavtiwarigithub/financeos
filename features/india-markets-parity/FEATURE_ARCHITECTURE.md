# India Markets Verification And Hardening

> Status: **REVIEWED DESIGN DRAFT. NOT APPROVED FOR IMPLEMENTATION.**
> Last reviewed: 2026-07-15 by Codex.
> Scope: India Markets page correctness and resilience; no scoring or trading.

## 1. Correct Current-State Assessment

India Markets is implemented, but not yet production-proven:

- `MarketsPage` displays NIFTY 50, SENSEX, BANK NIFTY, India VIX, and ten
  sector-index tiles.
- `IndiaBreadth` fetches only the first ten fixed NIFTY-50 constituents. It is a
  sample, not NIFTY-50 market breadth.
- The client component imports `lib/india-data.ts` and calls Yahoo directly.
  Browser-side Yahoo access cannot rely on the server-only `User-Agent` header or
  Next.js revalidation semantics and bypasses Router pacing, durable caching,
  provenance, and health telemetry.
- `IndiaGapNote` conflates a transient India-source failure with a structural
  absence of an India equivalent.
- The page heading remains US-specific when India is selected.

The feature is therefore a verification and hardening project, not a greenfield
parity build. Sector and breadth UI must not be built twice.

## 2. Invariants

1. The browser never calls Yahoo, NSE, RBI, Kite, Upstox, or a provider directly.
2. US/USD and India/INR snapshots, caches, labels, and health are isolated.
3. Missing or partial data is displayed as unavailable/partial, never zero or a
   fabricated neutral market state.
4. Markets remains advisory. No tile changes scores, sizing, orders, or exits.
5. An unofficial source is capability-probed, cached, paced, and fail-soft; it is
   never described as guaranteed, unlimited, or an authoritative NSE feed.
6. Structural product gaps and transient operational failures use different UI
   states and System Health codes.

## 3. Target Contract

Create one owner/cron-gated server boundary that returns a frozen India market
snapshot. It must consume Canonical Evidence Router contracts or a temporary
compatibility adapter that is explicitly retired at Router cutover.

```ts
type IndiaMarketsSnapshot = {
  market: "india";
  currency: "INR";
  asOf: string;
  fetchedAt: string;
  status: "complete" | "partial" | "unavailable";
  policyVersionId: string;
  indices: Array<{
    symbol: string;
    label: string;
    price: number;
    changePct: number;
    observedAt: string;
    source: string;
    quality: "fresh" | "stale";
  }>;
  sectors: Array<{
    symbol: string;
    label: string;
    price: number;
    changePct: number;
    observedAt: string;
    source: string;
    quality: "fresh" | "stale";
  }>;
  breadth: null | {
    universeId: "nifty_50";
    universeAsOf: string;
    eligibleN: number;
    resolvedN: number;
    advanced: number;
    declined: number;
    unchanged: number;
    unavailable: number;
    coveragePct: number;
    quality: "complete" | "partial";
  };
  unavailable: Array<{ component: string; reasonCode: string }>;
};
```

The response contains no raw provider payload, token-bearing error, URL, cookie,
or arbitrary prose. Numeric fields must be finite and currency/basis validated.

## 4. Data Acquisition

- Use server-side, code-allowlisted adapters only.
- Prefer a fresh durable cache; serve bounded stale data with an explicit timestamp
  when allowed; enqueue bounded refresh work rather than burst on page load.
- Fetch index/sector symbols with bounded concurrency and atomic provider pacing.
- Use Kite/Upstox only when the owner's entitlement and contract allow it. Provider
  selection is policy-controlled, not hardcoded in the component.
- Yahoo is an unofficial fallback. Contract-test symbol semantics and adjustment
  basis; treat CORS, throttling, schema drift, and no-data as expected failures.
- Never scrape arbitrary NSE/RBI pages from a client or silently change source.

## 5. Breadth Correctness

Choose one honest product:

1. **Full NIFTY-50 breadth:** use a versioned, current constituent snapshot; resolve
   all eligible names from a common observation window; show breadth only at a
   pre-approved coverage floor and report `resolvedN/eligibleN`.
2. **Ten-name sample:** retain current behavior but rename it “10-name NIFTY sample,”
   disclose coverage, and never use the word breadth or compare it with full US
   breadth.

Recommended target is full NIFTY-50 breadth built asynchronously from cache, not 50
provider calls during page render. Constituents need effective dates so historical
replay does not use today's index membership. Advance/decline compares the current
session's valid reference close on a consistent adjustment basis; unchanged and
unavailable names remain in the denominator report.

## 6. Product States

- `loading`: bounded skeleton while the server request is active.
- `complete`: data plus `asOf`/source-quality summary.
- `partial`: render available rows and explicit coverage; no healthy-looking total.
- `temporarily_unavailable`: India capability exists but failed/staled out.
- `not_supported`: no approved India equivalent exists.

The India page heading and explanatory copy name India instruments. Leveraged bull/
bear pairs remain `not_supported`; they must not be synthesized. TradingView embeds
are optional third-party display surfaces, not a parity requirement or evidence.

## 7. Macro And Regime Boundary

Do not build an “India recession sentinel” in this feature. RBI policy rate, CPI,
WPI, IIP, yields, INR, and FII/DII flows differ in release cadence, revision,
economic meaning, and source authority. FII/DII flow is not a macro regime proxy.

A future India macro architecture must define official series, publication and
revision vintages, release calendar, staleness, deterministic regime math, and
validation. Until then, show a structural gap. LLM prose cannot create regime math.

## 8. Verification Plan

1. Add server-adapter fixture tests for success, partial payload, throttling, schema
   drift, stale fallback, bad currency, and non-finite values.
2. Verify no provider hostname appears in the client bundle/network log.
3. Browser-test the actual context switch, persistence, refresh, failure, and stale
   states; `?market=india` is not the context contract unless separately designed.
4. Verify India requests never read/write US cache keys and vice versa.
5. Verify the page always exits loading after timeout/error.
6. Verify full breadth coverage arithmetic and constituent-version identity, or
   verify the ten-name product is consistently labeled as a sample.
7. Confirm desktop/mobile layout and market-specific heading with Playwright.

## 9. Build Order

1. Live-test the current market switch and capture current browser/network failures.
2. Add the server-side snapshot contract and cache compatibility layer.
3. Remove direct client imports/calls to `lib/india-data.ts`.
4. Correct headings, transient-vs-structural states, and timestamps.
5. Decide full breadth versus explicitly labeled sample; implement only one.
6. Add System Health aggregation by component/provider, not one alert per symbol.
7. Revisit optional India-only displays after source contracts are proven.

## 10. Rollback And Acceptance

Disable the India snapshot endpoint/flag and render an honest temporary-unavailable
state; US remains untouched. Acceptance requires zero direct browser provider calls,
reproducible market-local cache keys, bounded loading, explicit partial coverage,
and no scoring/order imports. No Supabase migration or provider activation is
authorized by this document until the design is owner-approved.
