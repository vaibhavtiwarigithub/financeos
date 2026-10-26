# October 26 — discovery, leveraged funding and horizon review

## Finding

SOXL's daily research was 41/100, using completed October 23 technicals. Its
legacy fundamental field was excluded from the actual composite; the narrative
prompt nevertheless described that field as missing. The prompt now uses the
existing applicability contract and stamps
`research_thesis_v2_dimension_applicability`. Council scoring/prompts/weights are
unchanged. The council's 10-session outlook is not a forecast of today's move.

Natural paper checks initially rejected setup/proxy confirmation, then volume.
From 10:55 through 15:25 ET, 55 checks reported `below_minimum_entry`. The US
closing paper NAV was $9,802.06 and cash less than one cent, with six ordinary
positions and no leveraged position. Historical runs did not retain the full
sizing breakdown, so the closing balance cannot prove every earlier amount.
No SOXL fill occurred. No historical record was changed.

## Delivered scope

- All four dedicated paper planners retain exact minimum-size rejection
  evidence, including available notional and shortfall. Routes retain setup,
  quote time, research identity and account snapshot cash/NAV. Existing 0.5%-NAV
  minimum and combined 5% sleeve ceiling remain. A ceiling does not reserve cash.
- US dated Research Journal cards separate daily research, council horizon and
  latest same-day intraday decision. Old missing amounts remain unavailable.
  Outside-window runs cannot conceal the last eligible-window decision.
- Existing Alpaca adapter supplies fresh regular-session activity discovery.
  Two new names at most, fair discovery lane ordering, existing research budgets
  and cap exemptions, no extra schedule. Session/provider provenance reuses the
  existing card. Failure surfaces in System Health; verified empty arrays are
  valid. Post-fetch time prevents falsely rejecting a response newer than request
  start. No score or trade is inferred from inclusion in an activity list.

## Source and research verification

Existing credentials returned HTTP 200 for both Alpaca most-actives and movers,
10 rows each, `last_updated=2026-10-26T22:07:00.072913002Z`. This after-hours probe
verified access/schema only; it did not enqueue research or establish SIP quote
entitlement. The new lane admits only regular-session payloads.

Official contracts: [most-actives](https://docs.alpaca.markets/us/reference/mostactives-1),
[movers](https://docs.alpaca.markets/us/reference/movers-1).
The first scratch probe failed before provider access because the test runner
does not load `.env.local` in test mode; loading the existing configuration in
the isolated probe resolved it. No credential values were printed or saved.

[Market intraday momentum](https://doi.org/10.1016/j.jfineco.2018.05.009)
studies opening versus closing half-hour market returns; it does not validate a
morning SOXL reversal. [Momentum Crashes](https://www.nber.org/papers/w20439)
motivates conditional rebound testing, not unconditional oversold buying.
[Cboe's VIX explanation](https://www.cboe.com/insights/posts/what-the-vix-and-vix-1-d-indices-attempt-to-measure-and-how-they-differ/)
describes expected volatility, not a directional price forecast. Practitioner
claims were not treated as verified net returns. The consolidated architecture
requires chronological held-out and paired forward portfolio evidence, costs,
trial counts and failures; no new indicator threshold was fitted to this rally.

## Verification record

Initial full suite: 4,467 passed, eight skipped, zero failed; TypeScript passed.
One new post-fetch-clock regression fixture initially modeled an instantaneous
response with a future timestamp; corrected it to simulate a real fetch delay.
Its seven-test provider suite then passed. Final full suite: 4,468 passed, eight
skipped, zero failed. TypeScript and changed-file secret scans passed. Exact
remote/production release verification is performed at delivery.
No database migration, model call, manual trade cron or broker order was used.

## Remaining queue, not claimed complete

1. Verify new evidence/admission on the next natural eligible session; old
   historical funding amounts cannot be manufactured.
2. Build a paired portfolio replay for funding qualified setups from invested
   capital: incumbent sale selection, exact lots, opportunity cost, turnover,
   costs, sector/opposing exposure and atomic execution. Automatic funding sales
   are not part of this repair.
3. Predeclare one earlier-entry/rebound challenger, validate across sessions and
   both false entries and missed recoveries before changing the entry rule.
4. Continue exact-version formula/council evaluations and stalled approved
   producer repairs; insufficient labels are not failed predictions or proof.
5. Complete account-specific Guardian/protective lifecycle and cash-flow-based
   live return histories. Capital/loss/duration mandate bounds remain necessary
   for live changes; primary Robinhood remains excluded from execution.

Full decision and queue:
`features/discovery-execution-clarity/FEATURE_ARCHITECTURE.md`.
Prior source/Guardian/account blockers remain in the October 25 audits and
WORK_LOG; this release does not represent a complete System Health re-audit.
