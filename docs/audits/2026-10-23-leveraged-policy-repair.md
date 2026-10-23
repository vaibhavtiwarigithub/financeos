# Leveraged policy repair and recommendation reconciliation

## Repairs implemented in place

1. SOXL now uses `leveragedPriceTarget`, as SOXS/TQQQ/SQQQ already do. For
   example, entry 100.1 and stop 99.7 produced 100.89999999999998 with inline
   arithmetic; the common helper emits 100.9. The database's full-risk 2R floor
   is unchanged. With a two-ATR minimum risk and three-ATR candidate reward,
   the 2R floor dominates the current v3 target; this is a fixed operational
   rule, not an optimized target or demonstrated edge.
2. The shared ladder accepts an explicitly selected entry-distance trail for
   the exact four recorded intraday-v3 paper policies. It no longer imposes
   an unrelated 1% minimum distance on a narrower recorded intraday risk.
   Legacy leveraged lots, ordinary stocks and dormant live behavior retain
   their defaults. Stops never loosen or apply a new high retroactively.
3. The shared setup evaluator records explicit failed ETF opening-range,
   ETF VWAP, directional-proxy and same-time-volume conditions. It preserves
   the admission predicate; a new explanation is not a new entry rule.
4. All four paper doors preserve parseable run summaries up to 8,000
   characters. Previously both the response wrapper and ledger writer sliced
   JSON at 500 characters, silently losing later evidence and JSON validity.
   Exceptional oversized payloads retain bounded status/reason/liveness and
   disclose truncation. Historical truncated rows are not reconstructed.
5. Production's latest-symbol research query lacked a matching index. Three
   natural attempts on October 23 timed out (TQQQ 14:16 UTC; SOXL 14:45 and
   15:10 UTC). The existing pending-long partial index cannot satisfy a query
   that must see newer neutral/short verdicts too. Applied migration
   `20261023173459_leveraged_signal_lookup_index`, verified its tracker entry
   and valid `(market,symbol,created_at DESC)` definition. The exact SOXL
   query changed from a 15,716-row sequential scan / 2,196 shared buffers /
   2,028.698 ms execution to a three-buffer index scan / 4.193 ms. These are
   measured plans, not a universal latency guarantee. Signal selection,
   freshness gates, RLS and grants are unchanged; advisor categories did not
   increase. No application timeout was raised.

No new table, route, provider, dependency, schedule or inference loop was
created. The existing four doors, setup evaluator, ladder, risk helper and
signal-read ownership are reused. A read-only index is the only schema change.

A final provenance audit found that the broker parser validated each venue
side's time but discarded them after computing the conservative older-side
`observedAt`. The adapter now retains both event times, and the existing L1
collector persists them as additive quote JSON fields. Age/skew qualification
is unchanged. Existing rows cannot establish their lost per-side times and
are not backfilled; next-window persistence still needs a natural collection.

The first post-release SOXL natural check reached
`unclassified_portfolio_exposure`: JQUA and the legacy SQQQ holding have no
profile sector. JQUA's issuer confirms it is a US quality-factor equity ETF,
not an operating company. The canonical ETF registry now includes it. The
semiconductor risk owner bounds missing-sector recognized funds at their full
notional, multiplied by three for approved leveraged funds, never offset by
inverse direction. Unknown companies still fail closed. This conservative
upper bound is labelled/versioned on SOXL fills and can still exhaust capacity;
it is not measured fund look-through or permission to exceed the existing cap.
Profile-query failures now return an error rather than masquerading as absent
sector metadata. No existing position or profile row was rewritten.
[J.P. Morgan's JQUA description](https://am.jpmorgan.com/us/en/asset-management/adv/investment-strategies/etf-investing/investment-ideas/jqua-why-invest-in-quality-factor-etfs/).

## Natural production evidence, not manually triggered trading

Before this release, at the October 23 17:32 UTC checkpoint, SOXL had 47
successful scheduled runs and two failed attempts; TQQQ 49 and one; SOXS 48
and zero; SQQQ 56 and zero. Later successful runs showed current completed
Alpaca IEX bars and qualified monitoring. SOXL/TQQQ/SOXS waited on their setup;
waiting is not a broken producer or proof a buy would have won. SQQQ's legacy
position was monitored with action `none`. Its stale-monitor alert resolved
naturally at 13:32 UTC, not through a manual alert edit. There were no recorded
v3 paper positions at this checkpoint. This proves collection/decisions and
legacy monitoring, not a new v3 entry/partial/end-of-session lifecycle.

## Recommendations already implemented before this patch

- Four common intraday entry windows, completed ETF/proxy bars, inverse sign,
  current-session VWAP and matched elapsed-time volume; fresh research context.
- Two-minute paper marks, five-minute scheduled checks, atomic combined 5%
  sleeve/eight-symbol/cash/opposing-pair checks and 0.5%-NAV minimum new entry.
- New v3 lots attempt a full exit in the final fifteen minutes, with next-session
  retry if an earlier attempt could not close. Old lots are not relabelled.
- No full-session pre-entry highs/lows replayed against a later entry.
- Sub-cent amounts display honestly; original SQQQ dust is not deleted, topped
  up or ignored when enforcing the opposing-position rule.
- Council forecasts explicitly target ten sessions, not today's intraday move;
  prediction-only prompt lineage is separate from legacy permission-contaminated
  evidence. Council does not choose intraday stop/target/order permission.
- Live benchmark component/benchmark-registry parity is built, with gaps and
  fixed account cohorts; without a verified flow ledger it is equity change,
  not cash-flow-adjusted investment return.
- Upgrade Path source/results/completion routing and production-read repairs
  are on main. See `2026-10-23-upgrade-path-results.md` for measured evidence.

## Still pending: do not mark these completed

| Priority | Recommendation | Missing work / safe next action |
|---|---|---|
| Safety | Live protective stop/cancel/fill lifecycle | Real broker readback, partial/cancel-fill race and reconciliation proof remain absent. No live order or enablement was used to manufacture proof. |
| Data integrity | Continuous post-entry barrier coverage | Five-minute point marks can miss crossings. A future interval-bar implementation must prove the complete interval starts after the fill and ends before evaluation, and apply conservative intrabar ordering/costs. Do not substitute the day's low/high. |
| Evidence | First natural v3 trade lifecycle | Observe a genuinely admitted/funded setup and its subsequent partial/full/session-end actions. A no-cash book or failed setup is not permission to force a test fill. |
| Research | Proxy-thesis exit / reset-before-reentry | Current monitor has no active proxy-thesis consumer; re-entry requires a newer completed signal, not an independently qualified reset. Define and compare a fixed challenger before claiming these rules improve results; no invented exit/reset gate added here. |
| Research | Fill/cost and long-hold calibration | Entry quote/spread and point-mark exit assumptions are not validated fill costs. Compare executable-side costs, missed barriers, gaps and multi-session path risk; IEX is not a consolidated tape. |
| Results | Whole-lot reward | A 2R target is not 2R whole-lot profit: half at 2R and half at entry yields 1R before costs. Existing half/runner policy is retained, not called optimal. |
| Implementation | Paired Upgrade Path portfolio producers | Exit geometry, score exit, setup experts, rotation, challenger validation and downside hedge still lack verified program-specific paired-book producers. Reuse the existing paired replay/ledger/cost owners, freeze each treatment and capital-flow contract, schedule it, then verify durable results. Generic IC or selected-winner returns do not substitute. |
| Data dependency | India ATR and true live return | India ATR still needs its qualified paired/corporate-action contract. Live investment returns need verified account marks and cash flows. Neither is solved by changing the chart label. |
| Separate active claim | Markowitz construction shadow | Existing WORK_LOG claim remains separate and untouched by this repair. |

The SEC explains why daily-reset leveraged/inverse returns over longer periods
can differ materially from a multiple of the underlying return; it does not
establish that this app's setup or these constants are profitable:
[SEC investor bulletin](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/sec).

## Verification and release

Focused pure-policy/actual-route tests mock provider, database and broker I/O.
They exercise every fund's decimal target, tight trail, legacy default,
stop-first/non-loosening/no-retroactive stop and complete summary persistence.
Production index readback and EXPLAIN were real read-only checks. No manual
money-path cron, paid inference, credential action or broker order was used.
Final full suite including the provenance/fund-accounting follow-up: 4,368
passed, eight skipped, zero failed. Focused target/trail/signal
policy/route/signal suite: 142 passed. TypeScript passed and the exact-final-source
isolated Next build generated all 78 pages, exit zero. Generated scratch-build
TypeScript references were restored. Staged GitGuardian scan found no secrets.
Production deployment verification follows the push; pending items above remain open.

### First release proof

Runtime `4793508b` is on main and Vercel
`dpl_FDpjPrNRimRmUKf2sahoi2zuS29U` is production READY with canonical aliases.
All four anonymous paper-door GETs returned 401. Subsequent scheduled SOXS and
TQQQ runs persisted complete 853- and 783-character JSON summaries, including
explicit conditions and same-time relative volume; SQQQ continued healthy
monitoring. No manual money-path invocation was used. Following the index
migration, the first ten observed scheduled runs through 17:46 UTC were all
`done`, without the earlier latest-signal timeouts. This is observed recovery,
not a guarantee that a provider/database can never fail again.

The quote-provenance/fund-accounting follow-up `eaa553b9` is also on main;
Vercel `dpl_2R33PCKoJsbfkyaQozumFjf3YtUL` is production READY with both
canonical aliases. All four anonymous paper-door GETs again returned 401.
Per-side timestamp persistence awaits the next natural L1 window; today's
earlier observations retained only the qualified combined timestamp. The full
suite on the final frozen source passed 4,368 tests, eight skipped, zero failed;
TypeScript, scratch production build and staged secret scan passed. One earlier
run failed the newly added unsupported-leverage test while its implementation
was still being edited; isolated and full reruns on frozen source passed. That
intermediate development run is not presented as a production test flake.

The next natural SOXL run, at 18:10:12 UTC, returned `no_capacity` instead of
`unclassified_portfolio_exposure`. Read-only portfolio readback confirmed cash
is zero. This verifies the deployed accounting path's recovery without a forced
fill, not a new funded v3 entry or its eventual exit. The existing sleeve cap,
funding requirement, opposing-pair rule and historical SQQQ holding remain intact.
