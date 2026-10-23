# Supabase Disk I/O repair — 2026-10-23

## Confirmed scope

The 17:05 UTC Supabase email identifies FinanceOS (`dionkikgdmlaotvtbnfr`)
as depleting its Disk I/O burst budget, not running out of disk capacity.
No paid compute change, history deletion, trading action or inference is authorized
by this repair. A separate email identifies `hardware-ai-hub` as paused for 85
days and facing freezing in five days. That different project is not changed.

## Evidence and design

`pg_stat_statements` identified three repeated read shapes without matching
indexes. The global latest-score API paginates the history ordered by creation
time; its existing symbol-leading index cannot satisfy that global order. The
observed statement accumulated 1,337,528 temporary blocks written. Return-panel
queries order across symbols by availability; the existing symbol-leading index
does not match. Provider experiment reconciliation filters call receipts by run.

These counters are cumulative, not today's usage. `pg_stat_database.stats_reset`
is May 22, 2026; its 947 GB temporary-write counter must NOT be described as
today's disk traffic, current storage occupied or a proven single root cause.
Single EXPLAIN timings below are load/cache sensitive, not latency guarantees.

| Exact read shape (LIMIT 1,000) | Before | After | Verified change |
|---|---:|---:|---|
| Global score history, four breakdowns, created_at descending | 4,221.959 ms | 287.938 ms | Full 15,444-row scan/sort → ordered index; 3,111 → 761 shared buffers |
| US returns, session_date >= 2026-07-25, available_at descending | 8,764.635 ms | 12.783 ms | Parallel scan/sort → market/availability index; 3,754 → 143 shared buffers |
| Provider receipts, nonexistent run-id array (no row changes) | 987.297 ms | 1.332 ms | 62,996-row scan → run-id index; 2,166 → two shared buffers |

Migration `20261023184400_disk_io_hot_read_indexes` was applied through the
production migration API. All three indexes are valid and ready. Sizes measured
after creation: 360 kB / 1,728 kB / 464 kB respectively. The migration has a
two-second lock wait and a 45-second per-statement execution bound. It adds no
columns, constraints, RPCs, grants, policies, scheduler or query behavior.

## October 30 access-grant notice

The email says only newly created tables lose automatic API grants. Existing
tables keep their grants. Production inspection found zero public ordinary or
partitioned tables lacking service-role SELECT. This is a read-access check,
not a proof that every write grant or future migration is correct. New table
migrations must explicitly grant only the intended role/operations and retain
RLS. No blanket grants or RLS changes were applied.

## Advisor baseline and limits

Baseline security: 113 INFO deny-by-default RLS/no-policy findings; seven mutable
search-path warnings; one each public-extension, authenticated-definer and
leaked-password-protection warning. Baseline performance: 63 unindexed-FK INFO,
48 auth-initplan warnings, 78 unused-index INFO, one overlapping-policy warning
and three duplicate-index warnings. These are not all causes of this I/O email.
No broad security/policy rewrite or blind index removal is part of this patch.

The project reports ACTIVE_HEALTHY after repair. That status does not prove the
burst budget has replenished. OS swap, WAL/checkpoints, writes and other query
shapes can still contribute. The actual remaining burst budget and natural
post-repair traffic must be reviewed in Supabase Database Health before claiming
the warning is fully resolved. A larger compute tier, if still needed after
measurement, requires a separate cost decision.

## Verification

Production migration history and all three index definitions/readiness checked.
Identical SELECT predicates/projections were EXPLAINed before/after, with no
data writes. India also uses the market/availability index: 86.235 ms / 150
shared buffers for the same 1,000-row shape (no pre-repair India timing claimed).
Focused tests: four passed. Full regression: 4,372 passed, eight skipped, zero
failed. TypeScript exited zero. Security/performance advisor rule counts are
unchanged after the additive indexes. Browser dashboard verification timed out;
remaining I/O budget is not independently verified. Publication is to main;
database changes are already live and do not depend on a Vercel runtime change.

Main `77a733d1` deployed READY as `dpl_ETwajZ8ME1SUSJ42PyNDkicsgMcE` with
the canonical production aliases. Its build surfaced a newly updated critical
DOMPurify advisory affecting installed 3.4.16. A compatible transitive update to
3.4.17 changes one package only and retains Mermaid 10.9.8. npm's production
audit after the update has zero high/critical findings; two low Mermaid/KaTeX
findings remain, with the offered fix requiring a Mermaid major upgrade.
No exploitability of the specific DOM modes is asserted for Kairos. Source:
https://github.com/advisories/GHSA-cg2g-xh64-v4q7 . Follow-up checks and deployment
are verified separately; the database indexes are unaffected. Follow-up local
verification again passed 4,372 tests / eight skipped / zero failed and tsc.

### Subsequent connection failure and build boundary

After the index proofs, management SQL timed out twice including `SELECT 1`.
A separate authenticated REST SELECT also hit a 12-second bound. Gateway-only
checks returned 401 quickly, which proves routing, not database health. The
Management API still described the project as ACTIVE_HEALTHY. Limited log
attribute aggregation found no timeout/connection-slot/OOM strings, but does not
establish absence of failures. Supabase's status page also reported an ongoing
multi-region Management API incident; causation for this project's failure is
not established. Stop heavy diagnostics and do not claim capacity recovery.

The sanitizer release then exposed an existing build-time dependency: the private
live-portfolio page used 60-second ISR and attempted database reads during static
generation. It exceeded Next's 60-second generation bound. Making that page
request-rendered preserves its reads/UI while removing private data and external
database availability from the build. It does not hide or repair runtime failures.
