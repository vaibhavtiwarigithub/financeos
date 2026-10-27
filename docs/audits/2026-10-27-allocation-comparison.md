# Portfolio goal/current allocation comparison

Owner requested category-level pies below paper allocation and the same view
on both live market pages. The view reuses saved market allocation profiles,
instrument taxonomy and Recharts. Two matching donuts and a complete eight-row
table explain targets/current/gaps, including zero-target categories. Settings
Trading remains the place to change goals. No scores, targets, trading rules,
kill switches, live activation, financial records, provider calls or schedules
were changed by this feature.

Paper comparison value is marked holdings plus cash, matching Settings; persisted
NAV can lag marks and is not the denominator here. Missing marks do not fall
back to entry cost. Tactical cash and leverage share one bucket, counted once.
Live goals are explicitly a reference to the paper policy, not a live mandate.
US uses selected real-account snapshots, deduplicated with saved broker marks.
Residual account value is unverified rather than claimed as cash or buying power.
Unknown holdings/balances are separate slices; category shares become minimums
and exact gaps are withheld. Invalid, short, inconsistent or incomplete books
withhold the current donut. No failed settings read substitutes invented defaults.

India uses the existing NSE-delivery plus margin comparison basis when available;
margin is not verified cash. Coin and same-day positions are excluded. Kite's
own definition separates net margin, collateral and raw cash:
https://kite.trade/docs/connect/v3/user/#funds-and-margins . Existing NAV records
and broker-account data were not rewritten.

## Evidence

- Full final suite4,554 passed/eight skipped/zero failures. Focused28 tests,
  TypeScript, diff and secret checks passed.
- Runtime a4b08ef763b91c3b511a837de389a8dba3c007b8 matched remote main;
  production dpl_5Gpd1fe5NWMGLiTV8nwgo4ygNME4 READY and canonical app verified.
- US and India paper both render two donuts; all eight displayed target/current
  percentages match the existing Settings API calculation exactly. Policy
  revisions remain US2/India3, both aggressive and enabled.
- Webull selected live account renders two donuts with about95.9% verified
  individual-stock exposure and4.1% unverified balance at the checked snapshot.
  No cash claim or precise unclassified gap is made.
- India live shows the saved goal and unavailable current values because Kite
  remains disconnected/unavailable. Expected Kite HTTP503 is not suppressed.
- Real layouts have no page overflow at320/768/1440. Paper has no JS page errors.
  Same component is shared across all views; tooltip/color/percentage table
  visually inspected. The Settings link targets the Trading tab.
- Browser-only settings503/Retry and inactive-goal fixtures passed and were
  removed. Rapid US/India/US switching retained the final US policy, preventing
  an old market response from replacing it. No actual policy was saved in QA.
- Policy-only owner GET returns only policy with private/no-store headers,
  skipping unrelated paper-book reads. The public viewer performs no new owner
  allocation fetch.

## Source correction and remaining verification

The combined US live current pie is withheld while two Robinhood snapshots have
reported/stored position counts of7/5 and16/15. Diagnosis found the deterministic
`refreshViaMcp` upsert replaced positions_json but omitted position_count, allowing
the older count to survive. The existing upsert now stores a.holdings.length
with that exact capture's holdings array, matching the other broker writers.
No old financial/snapshot rows were patched and no broker capture was manually
invoked. A successful natural refresh must prove count/array equality before
the aggregate pie is declared recovered. Individual complete accounts work.

The real-route regression mocks all broker/provider interfaces, proves one
snapshot upsert contains count2 with the same two holdings, no network calls,
and a failed capture preserves prior snapshots instead of writing zero. The
focused post-correction suite passes24 tests, including existing broker-refresh
boundaries and allocation arithmetic; TypeScript and secret checks accompany
release. The full4,554-test chart suite preceded this one-field metadata repair.
Kite reconnection remains an owner/source issue; no fabricated holdings or cash.
