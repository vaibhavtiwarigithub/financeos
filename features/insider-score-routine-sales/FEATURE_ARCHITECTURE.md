# Feature Architecture: Insider Score, Routine Sales (PROPOSAL)

## Status
**IMPLEMENTED 2026-10-14 as a measure-only shadow (owner approved).** Nothing here changes the live insider score or any weight. Deviations from this draft: the live insider score is Massive-first (EDGAR is only its second source), so v2 could not reuse existing fetches and runs as its own SEC job (`/api/agents/insider-v2-shadow`) into the append-only `insider_v2_shadow` table instead of `decision_observations.features`; the flag is filing-level `<aff10b5One>` (verified on real AAPL filings), so all sales in a flagged filing count as planned. Evaluation reuses the score-variant machinery (`variant_set='insider_v2'`, baseline slot = insider v1 from the same filings).

## Problem (evidence)
- US `insider_score` is 10% of the composite. In the sampled window it was negative in both halves (top-minus-bottom-fifth spread -0.14% then -1.81%, mean rank IC -0.094, t -1.54; `docs/audits/2026-10-14-us-book-vs-xlk-and-score-quality.md`).
- It is available for only 39.9% of US observations; the other 61% hold a neutral 50 (the availability mask correctly excludes them from weighting).
- Mechanism, from `lib/data/edgar-insider.ts`: only Form 4 transaction codes `P` (open-market buy) and `S` (open-market sale) are counted, but `S` includes pre-planned Rule 10b5-1 and compensation-driven sales that executives make routinely. The score is `10 + 80 * buyValue / (buyValue + sellValue)`, so any company whose insiders only sell scores 10 ("0 buys vs 105 sells -> 10"). Large caps nearly always look this way, so the dimension largely encodes 'is a large, well-compensated company', not insider conviction.

## Proposed change (shadow only)
1. Parse the Form 4 Rule 10b5-1 indicator. Form 4 has carried a 10b5-1 checkbox since 2023 (XML field believed to be `aff10b5One`); verify against a real filing before building. Classify each `S` as `planned` or `discretionary`.
2. New dimension `insider_open_market_v2` computed in parallel, never replacing v1: counts open-market buys (`P`) and DISCRETIONARY sales only; planned sales are ignored. Score = buy share of discretionary flow, available only with at least MIN discretionary transactions (existing `MIN_INSIDER_TRANSACTIONS`); otherwise unavailable, never neutral-filled.
3. Persist v2 next to v1 in `decision_observations.features.insider_v2` (additive jsonb key, no schema migration needed) and evaluate it as a new pre-registered variant set (`variant_set_v2`, new `declared_at`) with the same forward-only discipline as `features/score-variants-forward-shadow`. v1 and the live composite are untouched.
4. Adoption (not part of this proposal): forward sample meeting the council-grade evidence gate, t >= 2.4, then owner approval through the existing challenger path.

## Costs and risks
- Fetch cost: already downloads each Form 4 XML; adds one parsed field, no new request.
- If the 10b5-1 field is absent or unreliable on older filings, those transactions fall back to 'unknown' and are excluded from v2 rather than guessed.
- Supporting literature on routine vs opportunistic insider trades is from training knowledge, not re-verified here; the forward test, not the literature, is the arbiter.

## Open decisions for the owner
1. Approve the shadow (parse the indicator, add v2 beside v1)? 
2. Minimum discretionary transactions before v2 is available (default: same as v1).
