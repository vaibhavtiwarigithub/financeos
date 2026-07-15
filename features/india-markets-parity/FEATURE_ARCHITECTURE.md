# India Markets-Page Parity — FEATURE ARCHITECTURE

> Status: **Draft / not approved / implementation not allowed.** Design only.
> Last updated: 2026-07-15.
> Per-market applicability: **India-focused** (closes an India gap on a shared page); must not regress US.
> Update this file when: India index/sector/regime sources or the US-only-tile gap list change.

## 1. Reality check (correct the record)

`components/dashboard/MarketsPage.tsx` is already market-aware, not US-hardcoded:
- India selected → `fetchIndiaIndices` (NIFTY 50 / SENSEX / BANK NIFTY / India VIX) + `fetchIndiaSectors` (10 free NSE sector indices via Yahoo `.NS`).
- Genuinely-US-only tiles (TradingView sector charts, Macro Recession Sentinel, leveraged bull/bear pairs, sector-breadth) are wrapped in an honest `IndiaGapNote` — the code explicitly refuses to fabricate India data.

So this is **not** "India Markets is broken." It is: **(a)** verify the India Yahoo fetches actually return under live conditions, and **(b)** decide which honestly-labeled US-only tiles deserve a real India equivalent (free source permitting).

Note: the in-app market switch is a **context toggle, not a URL param** — `?market=india` does not flip it. Any live verification must click the switcher (or set the context), which is why an unauthenticated URL check shows the US view.

## 2. Scope

**P0 — verify + harden India data path (measure, then fix only if broken):**
- Confirm `fetchIndiaIndices` / `fetchIndiaSectors` return non-empty for a normal session; if Yahoo `.NS` is flaky, add the same cache-first + graceful-degrade pattern the US Markets fix uses (read a cached India snapshot, one bounded fetch, honest gap note on miss — never a permanent "Loading…").
- Ensure "Loading…" always resolves to either data or an `IndiaGapNote`, never spins forever.

**P1 — India equivalents for the US-only tiles (only where a free source exists):**
| US-only tile today | India equivalent | Free source | Verdict |
|---|---|---|---|
| Sector performance / heatmap | NSE sectoral indices (NIFTY IT, BANK, AUTO, PHARMA, FMCG, METAL, REALTY, ENERGY…) | Yahoo `.NS` (already partially wired) | **buildable** |
| Sector breadth (advance/decline) | NIFTY 50 / sector advance-decline | Yahoo per-constituent or NSE | **buildable, bounded** |
| Macro Recession Sentinel (US: FRED indicators) | India macro read (RBI repo, CPI/WPI, IIP, yield curve, INR) | curated RBI calendar + reachable NSE/GDELT macro (see [[india-data-coverage]]) | **partial — advisory only** |
| Market synthesis / regime read | India regime from India indices + India VIX + macro | derived from the above, deterministic | **buildable** |
| TradingView sector charts | TradingView India symbols (NSE:…) | TradingView embed | **cheap** |
| Leveraged bull/bear pairs | — India has ~no liquid leveraged/inverse ETFs | none | **keep honest gap note** |

**Out of scope / stays US-only by reality:** leveraged-pair sentiment (no India instruments) — same reason the downside-hedge is US-only.

## 3. Boundaries
- Display/advisory only — the Markets page never touches scoring/sizing/orders.
- Deterministic prices/indices; LLM only for the advisory regime prose (already the case), never for the regime math.
- **Per-market never mixed** — India tiles use India sources + ₹; US tiles use US sources + $; no cross-summing.
- Free-cloud-only sources (Yahoo `.NS`, NSE, RBI, GDELT). No paid India data.
- Reuse the US Markets cache-first pattern (`price_cache` analogue or an India snapshot) so page-load never bursts a provider.

## 4. Open decisions (owner / Codex)
1. **How far to chase India parity** vs accept honest gap notes? Recommend: P0 (verify/harden) always; P1 sector + breadth + regime (buildable free); leave leveraged-pairs as an honest gap.
2. **India macro sentinel**: build a real India recession/regime indicator set, or keep it a labeled gap until a reliable free India-macro feed is proven? Recommend: start advisory-only from the curated RBI calendar + NSE FII/DII, clearly low-confidence.
3. **Verification method**: needs a live in-app market switch (context), not a URL — add a lightweight self-test/log that records whether India fetches returned, surfaced in System Health.
