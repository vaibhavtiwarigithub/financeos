# Core Pages Audit — 2026-07-12

Scope: live browser and code-path review of Agents, Markets, US Live Portfolio, India Live + Signals, and Research Journal. No live order was submitted and no trading configuration was changed.

## Verdict

The pages now present their available data consistently and fail safely, but external-data availability is not complete: Kite requires its daily reconnect, Macro Sentinel currently has 0/8 inputs because its free source was rate-limited, and Market Synthesis cannot produce a regime when its seven proxy quotes are unavailable. Those states are now labeled unavailable/insufficient rather than presented as valid neutral conclusions.

## Confirmed defects fixed

| Severity | Page / path | Defect | Fix and verification |
|---|---|---|---|
| High | Research Journal / research pipeline | The journal reduced selection to a score and discarded the stored thesis, provenance, dimension weights, evidence, risks, and pipeline events. A pipeline message could say `Score 83 < threshold 52` when a high score abstained for another reason. | Rebuilt the journal from immutable `decision_observations`, matching `agent_signals`, `research_packets`, and `pipeline_stage_events`. Each stock now shows why it entered research, the thesis, score construction, evidence quality, gates, catalysts, counter-evidence, and terminal stage. Corrected new event reasons to distinguish thin evidence, parse failure, below-threshold rejection, and direction abstention. Browser-verified US (42 symbols) and India (8 symbols). |
| High | Research pipeline | Thesis parsing used a greedy brace regex, which can merge multiple JSON objects/prose braces and turn usable model output into a parse failure. | Added bounded JSON/fenced-JSON parsing with balanced braces and strict direction validation. It makes no extra provider call and still fails closed if structured output is genuinely invalid. |
| High | India Live + Signals | Neutral signals, including a score-93 example, displayed an actionable `Buy via Kite` control; the control also appeared actionable while the daily Kite token was expired. | Order panel now opens only for LONG signals while Kite is connected. Neutral buttons say `Not entry-eligible`; LONG buttons say `Reconnect Kite` when disconnected. Browser-verified all controls disabled with the expired token. |
| High | US Live Portfolio | When the secondary quote adapter missed a symbol, the API discarded a valid broker-snapshot current price and substituted cost basis. That silently changed P&L to 0% while looking like a current quote. | Quote precedence is now external quote → broker snapshot price → explicitly flagged cost-basis fallback. Snapshot-derived prices carry a source marker; unavailable prices carry a warning. Browser-verified snapshot prices and internally consistent P&L. |
| Medium | Markets | Zero available regime inputs were labeled `NEUTRAL`, a substantive market conclusion unsupported by evidence. | Added `unknown`/`INSUFFICIENT DATA`; neutral is possible only when at least one signal was actually scored. Browser-verified the current 0/7 state. |
| Medium | Markets | Sector heatmap could remain behind a lazy-loading fallback even after overview data arrived. | Made the small chart component a direct import. Browser-verified `Sector Heatmap` renders and the loading fallback disappears. |
| Medium | Agents | Negative paper dollar P&L omitted its minus sign (`$20.35` beside `-0.20%`; HOOD `$22.49` beside `-2.12%`). | Corrected currency formatting. Browser-verified `-$20.35` and `-$22.49`. |
| Medium | Agents | Agent descriptions stated obsolete behavior: score-only paper entry, fixed 10% sizing, LLM/Robinhood paper prices, and Learner directly adjusting weights. | Updated the UI to describe eligibility/evidence/risk gates, deterministic price adapters, governed challenger proposals, and human/validation promotion. Removed duplicated DeepSeek empty-state copy. |
| Medium | All dashboard pages | Header displayed the computer's local clock as `ET` and approximated DST by month. | Clock and US session status now use `America/New_York` through the IANA timezone database. Browser-verified the corrected ET time. |
| Low | All pages | Next.js emitted an unsupported metadata viewport warning on every route. | Moved viewport configuration to the Next.js 15 `Viewport` export. Production build no longer reports that warning. |
| Medium | Research Journal | UTC-day filtering misfiled India pre-open observations and US evening reruns; weekends showed a misleading empty current day. Database errors were silently converted to empty results. | Journal filters by market-local calendar day, automatically selects the latest completed run when today has none, validates input, bounds all reads, and returns query errors rather than manufacturing an empty state. |

## Data-state observations (not hidden as bugs)

- India holdings and order entry need the normal daily Kite reconnect. This is a credential/session state, not a code failure.
- Macro Sentinel currently has 0/8 indicators, so it correctly reports UNKNOWN. It must not influence risk or entry as though that were a neutral macro reading.
- Market Synthesis currently has 0/7 proxy signals while the separate index overview has cached prices. The synthesis correctly abstains; provider consolidation/caching is a future reliability improvement, not grounds to fabricate a regime.
- US Live Portfolio is a six-account aggregate: 26 unique symbols, approximately $164.1k total equity, $139.2k buying power, and about -$3.9k total unrealized P&L at audit time. Privacy mode masks by default and reveals only on click.
- Many historical Jul 10 signals contain `[abstained: thesis parse failed]`. The safe result is abstention. The parser fix improves future runs; historical append-only records are intentionally not rewritten.
- Live Portfolio snapshots still identify themselves as manual synchronization. Until a reliable cloud refresh is proven, the UI must continue to disclose snapshot age.

## Verification

- TypeScript: `npx tsc --noEmit` — pass.
- Tests: 38 files passed, 1 skipped; 302 tests passed, 6 skipped.
- Production build: `next build` — pass (49 static pages generated).
- Browser: expanded US journal evidence, switched journal to India, checked Agents P&L and descriptions, waited for Markets heatmap/breadth/synthesis, revealed US privacy mode, and verified India order buttons while Kite was disconnected.

## What a good stock research journal should contain

For every symbol and every immutable decision timestamp:

1. Selection provenance: holding reassessment, watchlist, theme, or screener bucket and matched criteria.
2. Point-in-time evidence: source/freshness/availability for each applicable dimension; missing and degraded evidence must be explicit.
3. Score construction: dimension score, structural/applied weight, contribution in points, scoring version, and confidence.
4. Thesis and counter-thesis: grounded summary, catalysts, risks, and contradictory facts—not a restatement of the score.
5. Eligibility decision: every gate and its result. A high score is one input, never the reason by itself.
6. Pipeline trail: research → portfolio/risk/re-entry gate → paper/proposal/execution, including the exact rejection reason.
7. Outcome and learning link once mature: forward return at the defined horizon, benchmark-relative result, labels, and which governed challenger/evaluation consumed it.

The rebuilt Daily Funnel implements items 1–6 from already-stored point-in-time data. Outcome/evolution remains in the existing Evolution view and immutable label/evaluation tables.
