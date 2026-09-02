# Quote cross-check — session alignment and dispute escalation

> Status: **DRAFT — awaiting approval.** No code written.
> Created: 2026-09-02
> Scope: `app/api/agents/position-monitor/route.ts` mark cross-check. Money path
> (a disputed symbol gets no stop, target or time-stop evaluation).

## 1. The live symptom

`position-monitor-quote-disputed:india`, CRITICAL, open since 2026-08-26 and
re-reported every run through 2026-09-01. Two open India positions —
`INDUSTOWER.NS` (qty 27) and `KAMATHOTEL.NS` — have been reported `unpriced`
on every PositionMonitor run for seven days.

Unpriced is not cosmetic. The route deletes a disputed symbol from `priceMap`
*before* the exit loop, deliberately:

> "A price too doubtful to record is far too doubtful to sell on, so a disputed
> symbol is removed from priceMap and reported UNPRICED — no stop, no target,
> no time-stop fill."

That per-run judgement is correct. Its multi-run consequence is not: **two
positions have been running with no exit evaluation at all for a week.**

## 2. Root cause: the comparison has no session alignment

The cross-check compares two numbers without requiring that they describe the
same market session.

```ts
const bars = await fetchUpstoxCandles(sym, 5);
const newest = bars.length ? bars[bars.length - 1] : null;
if (newest && ...) { crossPrice[sym] = newest.close; }   // date DISCARDED
...
const deltaPct = (Math.abs(live - cross) / cross) * 100;
if (deltaPct > MARK_DISPUTE_REFUSE_PCT) { /* refuse */ }
```

`fetchUpstoxCandles` parses `date` for every candle (`lib/data/upstox.ts:95`)
and the cross-check throws it away. The primary side has the same information
and also discards it: `fetchYahooQuote` sets
`retrievedAt = new Date(m.regularMarketTime * 1000)` — Yahoo's **exchange
timestamp for the quote**, not our fetch time (`lib/india-data.ts:62`).

**Both sides already carry the session. Neither is checked.**

### Proof from production

`INDUSTOWER.NS`, alert text: `yahoo_india 375 vs upstox 388.8, 3.549%`.

| session | Yahoo close (price_cache) |
|---|---|
| 2026-09-01 | **375** |
| 2026-08-31 | **388.79998779296875** |

The "disagreeing vendor price" **is Yahoo's own previous session**, matching to
four significant figures. The two vendors do not disagree about a price. They
disagree about which day it is, and a one-session lag is being reported as a
3.5% vendor dispute — permanently, because the lag recurs every run.

This also violates the module's own stated contract: *"no cross price simply
means the mark is recorded as uncorroborated, never as disputed."* A
date-mismatched bar is precisely a cross price that cannot be used, so it should
produce `uncorroborated`, not `disputed`.

### The second symbol is NOT the same bug

`KAMATHOTEL.NS`: `yahoo_india 233.89 vs upstox 225.09, 3.910%`. Upstox's 225.09
matches the 2026-09-01 close of 225.05; Yahoo's 233.89 matches no recent close.
Here the **primary** is the outlier and the cross is right — a genuine data
problem, where refusing the price is the correct outcome.

So the two symbols in one alert have opposite causes. A fix that only aligns
sessions would clear `INDUSTOWER` correctly and must still refuse `KAMATHOTEL`.

> Contributing factor, NOT bundled into this change: `isYahooQuoteStale` allows
> an India quote to be up to **4 days** old and still count as fresh
> (`lib/india-data.ts:47`). That tolerance makes a primary/cross session
> mismatch likely by construction. Worth revisiting for exit evaluation
> specifically, but it is a separate decision with its own blast radius.

## 3. Proposed change

1. **Carry the session on both sides.** Derive the primary's session date from
   `regularMarketTime` in exchange-local time (IST for India, ET for US), and
   keep the Upstox candle's own `date`.
2. **Compare only same-session prices.** Equal session dates → compare as today.
3. **Different sessions → `uncorroborated`, not `disputed`.** The mark is
   recorded, the position stays priced, and exits ARE evaluated. Emit a `warn`
   naming the lag and which side is behind — never a `critical`, and never a
   silent pass.
4. **Same session and delta > `MARK_DISPUTE_REFUSE_PCT` → unchanged.** Genuine
   disputes keep failing closed exactly as now. `KAMATHOTEL.NS` stays refused.
5. **Escalate persistence.** A dispute unresolved across N consecutive runs
   (proposed N = 3) raises a distinct alert stating that a position has been
   unguarded for N runs. An indefinitely unguarded position is a worse outcome
   than either vendor being wrong, and today nothing distinguishes "refused
   once" from "refused for a week".

Point 5 matters even if the session fix is perfect, because a genuine dispute
can also persist — as `KAMATHOTEL.NS` may.

### Explicitly NOT proposed

- Loosening `MARK_DISPUTE_REFUSE_PCT`. The threshold is not the problem;
  comparing different days is.
- Auto-selecting a "winner" vendor. Choosing which feed to trust on a genuine
  disagreement is a policy decision, not a bug fix.
- Changing the 4-day India quote-staleness tolerance (see §2 note).

## 4. Falsification

The fix is wrong if, after it ships, `INDUSTOWER.NS`-shaped cases (cross price
equal to the primary's *previous* close) still raise `disputed`, or if a
genuine same-session disagreement stops being refused. Both are directly
testable against the recorded alert values.

## 5. Blast radius

Only the mark cross-check. No change to scoring, sizing, entry, order routing,
or the exit RULES themselves — the change is about which prices are allowed to
reach the existing exit evaluation. Affects US and India, since the cross-check
is shared.
