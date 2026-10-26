# US paper leveraged operating liquidity

Owner requested the full discovery/execution fix on October 26, then clarified
that the leveraged maximum must scale at 5% of portfolio value, not a fixed $50.
The combined maximum was already 5%; $50 is the distinct minimum at $10,000 NAV.

## Policy reassessment and implemented change

Before: ordinary buys could spend all cash even though a separate leveraged
door had capacity under its ceiling. A ceiling neither reserved cash nor made
a cross-horizon replacement economically sound. Automatically selling a swing
holding for a five-minute setup requires evidence the app does not yet have.

After: prospective US PAPER ordinary entries/top-ups preserve unused sleeve
cash: `max(0, NAV * 5% - current combined leveraged value)`. The full-book gross
ceiling for these buys is at most `95% + current leveraged weight`, always
bounded by any stricter existing cap. Ordinary deployable cash excludes this
reserve. Invested leveraged value is never reserved a second time. Policy ID
`paper_sleeve_liquidity_v1`; no increased capital, loss limit or live exposure.

The shared fill function recomputes full marked NAV under its existing market
pool lock. This covers ordinary new entries, top-ups and atomic rotation buys.
Concurrent stale callers cannot spend the same reserve. A missing US transaction
kernel fails closed rather than falling back to non-atomic writes. Global
distinct positive held names, including leveraged roles, count at entry; the
existing eight-name mandate remains. Dedicated leveraged fills still enforce
the combined ceiling, minimum size, name/sector exposure, setup, freshness,
opposing positions, stop geometry and monitor liveness. No forced sale occurs.

At the read-only check, US NAV was $9,802.06, cash $0.000509 and India NAV
₹992,324.20. Both mandates were eight names. Consequently the US sleeve maximum
was about $490.10 and minimum new entry $49.01. The reserve cannot make that
already invested capital liquid: natural exits/trims must fund it. India has no
new US leveraged reserve. Live accounts and dormant live limits were untouched.

## Database and verification evidence

- CLI created the migration draft; the repository filename was aligned with
  MCP's applied ledger version `20261026224500`, name
  `paper_leveraged_liquidity_reserve`.
- Applied function has the reserve marker after `FOR UPDATE`, counts all roles,
  and keeps its existing signature/search path. `anon` and `authenticated`
  cannot execute; `service_role` can. No grants expanded.
- An isolated PostgreSQL 17 test used the actual pre-change function definition,
  applied the migration twice, and tested above/exact reserve boundaries, India
  isolation, invested sleeve credit, NaN refusal, eight-role-aware name counting
  and two concurrent local synthetic spends. Exactly one spend passed; the
  other saw `leveraged_liquidity_reserved`. The test server stopped cleanly.
  No production financial rows or broker orders were used. An initial fixture
  was missing a statement terminator; corrected before production migration.
- Pure tests compose the actual reserve, constructor and spend helpers, verify
  $10k/$25k/$2k scaling, invalid inputs and stricter caps. Synthetic full-book
  simulator pairs explicitly show a winning opportunity, no-opportunity cash
  drag and a losing opportunity. They are arithmetic scenarios, not historical
  performance or evidence of superiority.
- Security advisors unchanged before/after: 113 informational deny-all RLS
  notices; seven mutable-path functions and three other warning categories.
  Those pre-existing findings are not dismissed or called resolved by this
  migration. No paid authentication/compute change was made.

Full suite passed 4,478 tests with eight skipped and zero failed. TypeScript and
changed-file secret scans passed. Exact mainline/READY/UI checks are performed
before handoff. Existing future-session evidence must confirm natural
run behavior; no trading cron or extra inference is manually invoked.

## Trade-offs, rollback and remaining work

Holding operating cash can underperform when ordinary equities rise and no
leveraged setup arrives. A funded leveraged loser can also reduce portfolio
return. The reserve fixes funding contention, not prediction or guaranteed gains.
Sampled scenarios must never be presented as realized app P&L or used to choose
an optimized reserve. No extra shadow producer or recurring workload was added.

If JavaScript/SQL reserve accounting diverges, valid entries are incorrectly
blocked, or unexpected market/role effects appear, halt new affected entries
and restore the prior operating policy through a reviewed forward migration;
never bypass quote, loss, name, sleeve or protection gates. Historical positions
remain unchanged. Earlier-entry/VIX challengers, exact historical funding replay,
universal Guardian/live protection and cash-flow-adjusted live returns remain
separate evidence/account-dependent work in the consolidated queue.
