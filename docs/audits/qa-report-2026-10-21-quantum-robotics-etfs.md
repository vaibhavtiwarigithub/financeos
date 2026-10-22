# Quantum and robotics ETF coverage correction

Owner request/date: October 21, 2026, America/Chicago. Production verification
occurred around 8:46–8:48 PM Central (October 22 01:46–01:48 UTC).

## What was wrong

QTUM, BOTZ and ARKQ were listed with research disabled and no prior recorded
research. ROBO and ROBT were absent. QTUM, ARKQ and ROBT were also missing from
the canonical ETF classifier. The enabled US manual pool already contained 42
names; keeping a fixed newest-created-first order ahead of a smaller cap could
starve older manual entries indefinitely.

## Implemented and enabled

- Extended the existing canonical ETF set, not a second classification system.
  All five reuse existing ETF applicability: company fundamentals and corporate
  insider data do not contribute; missing applicable inputs are excluded.
- Reused the existing last-score reader/staleness ordering within the US manual
  pool. Holdings and leveraged monitoring remain first, discovery keeps its
  reserved slots, and no budget or cap exemption was added. This is a rotating
  research pool, not a promise that every enabled name is deeply researched daily.
- After deployment, used the confirmed-owner watchlist API to save all five as
  manual US research entries and explicitly enable them. All five have no expiry.
  Preserved normal account, cash, position, sector, correlation, execution and
  live-trading controls. Research inclusion is not broker eligibility or an order.
- Ran one bounded manual research request per ETF. No trade endpoint was called.

## Production proof

Runtime `00564f83`, deployment `dpl_E2nP4eWpJSgU1386iWHoS7ScRyBb`: READY,
aliases assigned. Owner watchlist POST/PATCH/read checks all returned HTTP 200.
Each of the five research requests returned HTTP 200 with ETF=true, a result,
the stream's completed event, and no symbol error.

| Symbol | Recorded composite | Stored family | Included dimensions |
|---|---:|---|---|
| QTUM | 41 | thematic_etf | technical, sentiment, macro |
| BOTZ | 24 | thematic_etf | technical, macro |
| ARKQ | 41 | thematic_etf | technical, sentiment, macro |
| ROBO | 43 | thematic_etf | technical, sentiment, macro |
| ROBT | 49 | thematic_etf | technical, sentiment, macro |

Read-only DB verification: five new US decision observations, all with active
`technical_dimension_v2_macd` lineage; fundamental=false and insider=false in
their availability masks. BOTZ's absent sentiment was false/excluded, not zero.
These scores are current observations, not promises of future performance or
instructions to force a purchase. No historical rows were rescored or relabelled.

Authenticated Fundamentals page displayed all five names and no desktop page
overflow. The separate **My Watchlist** page uses `user_watchlist`, whereas the
Home research Watchlist panel uses the scheduling `watchlist` table changed here;
do not claim the two are the same surface. Find current results on Fundamentals.

## Tests and release

- Initial focused classification/queue/remediation run: 28 passed.
- Full run caught one source-contract test matching the old manual-loop text.
  Updated it to verify leveraged-before-manual ordering with the sorted loop;
  did not weaken sleeve routing or alter its runtime priority.
- Follow-up focused leveraged/thematic tests: 29 passed.
- Final full suite: 4,108 passed, eight skipped, zero failures. Reports kept
  outside the repository. TypeScript, diff check and staged secret scan passed.
- No schema change, new provider, credential read, formula/weight mutation,
  new schedule, broker bypass or manual trade. A research enablement can feed
  future normal paper decisions only through the existing gates.

The completion commit adds tests/documentation only; runtime is the verified
release above. Other previously recorded app issues are not declared resolved.

## Issuer identity verification

- QTUM: https://www.defianceetfs.com/qtum/
- BOTZ: https://www.globalxetfs.com/funds/botz/
- ARKQ: https://www.ark-funds.com/funds/arkq
- ROBO: https://www.roboglobaletfs.com/robo
- ROBT: https://www.ftportfolios.com/Retail/Etf/EtfSummary.aspx?Ticker=ROBT

These funds can overlap and may hold foreign securities. Researching the ETF
does not mean its entire holdings basket is admitted or US-broker-tradeable.
