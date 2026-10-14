# Feature Architecture: India Paper Liquidity Floor

## Status
**Approved and implemented 2026-10-13** (owner: "Approved, implement both"). Paper trading only. No live/broker path.

## Feature Purpose
A paper fill assumes a modeled 0.05% slippage (`MODELED_SLIP_FRACTION`). That is only credible when the stock trades enough to absorb the order. India paper entries had no liquidity rule, so very thin names were being "filled" at prices the market could not have delivered.

## Evidence (production, measured 2026-10-13)
- 28 of 128 India symbols with >= 10 sessions of bars turn over < INR 1 crore a day; 15 of 112 entry-eligible symbols in 30 days.
- 8 of 171 India paper buys were in those sub-INR-1-crore names. Their realized P&L is **+INR 20,369 against +INR 17,587 for all India buys**; the other 163 buys net **-INR 2,782**. All of India's realized profit sits in the least tradeable names, which is the signature an unrealistic-fill artefact would leave. It is not proof of an artefact.
- Floor effect on the last 30 h of long signals (17 symbols): 5 blocked (ASHOKAMET 0.16 cr, MBECL 0.21, VHL 0.27, INTLCONV 0.39, UYFINCORP 0.60), 4 pass as "quiet" names (UNITEDPOLY, GLOBAL, OCCLLTD, SPECTRUM; 2.5-4.5 cr), 8 pass.

## Behavior
1. **Floor (`liquidity_floor`)**: India only, new entries and top-ups, checked after the signal claim and before pricing. 20-session average of close x volume must be >= INR 1 crore. Fewer than 10 usable sessions, or a failed bar read, fails closed (`liquidity_unknown`).
2. **Participation cap (`adv_participation`)**: after sizing, the order notional may not exceed 5% of the average daily turnover. Not binding at the current NAV (a 1.19 lakh position needs only 0.24 crore) but protects larger books.
3. **Alert classification**: a stale last-trade quote on a quiet India name (average turnover < INR 5 crore) is an *expected skip*, not "unavailable". Other stale quotes still count as unavailable. This removes the chronic `run-accounting:paper_trader:india` warn (about ten occurrences since August, each driven by `quote_stale` on thin names).
4. Both gates revert the signal claim and write a `liquidity_gate` stage row. Skips appear in the run summary skip breakdown.

## Non-goals / must not change
- Exits (`position-monitor`, `execute_paper_exit`) are never blocked. Existing holdings (VHL, INTLCONV, ...) are grandfathered; only adding to them is blocked.
- US entries unchanged. No threshold, score or sizing change. No live/broker path.

## Files
`lib/trading/liquidity-floor.ts` (+ test), `app/api/agents/paper-trade/route.ts` (bulk ADV read, two gates, accounting classification), `tests/paper-trade-liquidity-wiring.test.ts` (pins gate order and that position-monitor is untouched).

## Known limits and next evidence
- The floor value (INR 1 crore) is a measured judgment, not a fitted optimum. Thresholds of 2 and 5 crore would also exclude entries that lost money (-7,136 and -21,462 INR on 11 and 16 buys). Revisit after 8-10 weeks of post-floor India paper trades.
- Average turnover comes from `price_cache`; a symbol with stale bars is judged on its last 20 bars. Prewarm keeps scored symbols fresh.
- Existing positions already in thin names remain exposed to the same fill-realism issue on exit; not addressed here.
