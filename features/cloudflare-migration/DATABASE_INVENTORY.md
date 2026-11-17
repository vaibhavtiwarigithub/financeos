# Cloudflare migration database inventory

**Snapshot:** 2026-11-17. Read-only Supabase SQL/MCP and repository scan. This is an inventory checkpoint, not a migration or cutover approval.

## Source database size

| Measure | Value | Notes |
|---|---:|---|
| Postgres database size | 829,328,531 bytes (790.8 MiB) | `pg_database_size(current_database())`; read-only live query at 2026-11-17 21:17 UTC |
| Public relation sizes summed | 800,972,800 bytes (763.8 MiB) | `pg_total_relation_size` across user tables |
| Public tables | 274 | `pg_stat_user_tables` |
| Estimated live rows | 433,273 | Planner estimates; exact per-table counts still required for the final export manifest |
| Applied Supabase migrations | 439 | `supabase_migrations.schema_migrations` |
| Public tables with RLS enabled | 274 / 274 | RLS enabled everywhere; policies still need explicit security-semantic translation |
| Public policies | 204 | Table-count parity alone cannot preserve these rules |
| Public triggers | 236 | Trigger bodies and side effects must map to explicit write paths/jobs |
| Public functions | 155 | In addition, 84 statically named RPC calls were found across 55 files |
| Installed extensions | 8 | Includes `vector`, `pg_cron`, `pg_net`, `supabase_vault`, and `uuid-ossp`; not drop-in D1 features |
| Repository `.from(...)` calls | 1,877 | `app/`, `components/`, and `lib/` text scan |
| Distinct statically named tables queried | 246 | Some dynamic query construction may be missed; generated SQL/RPC callers need a separate scan |

The relation-size sum is lower than the database-size result because database-wide catalogs, schemas, and other allocations are not represented by the summed public relations. Neither measure is the compressed dump size. The 433,273 row figure above is a planner estimate and is materially stale; exact counts on the largest relations alone exceed 650,000. Use per-table exact counts from the live source for migration manifests, not this aggregate estimate.

The 84 static RPC call sites span 55 files. Security parity requires translating the 204 policies, not merely copying the fact that all 274 tables have RLS enabled.

## Largest public relations

Sizes below include heap, indexes, and TOAST as measured by `pg_total_relation_size`; row counts are estimates.

| Table | Estimated rows | Total bytes | Initial migration treatment |
|---|---:|---:|---|
| `symbol_daily_returns` | 10,392* | 90,562,560 | Existing separate R2/D1 archive cohort; verify complete 261,678-row export and consumer parity before treating as done |
| `decision_observations` | 1,150 | 80,035,840 | Append-only evidence; determine live readers and retention contract before archiving |
| `research_packets` | 1,150 | 62,881,792 | Linked research records; preserve relational identity and joins |
| `observation_labels` | 45,424 | 46,333,952 | Evaluation labels; preserve immutable outcome semantics |
| `price_cache` | 190,358 | 44,974,080 | Bounded market cache candidate; keep required recent data hot, archive only with reader fallback |
| `signal_score_history` | 1,150 | 42,033,152 | Score history; data move only, no scoring changes |
| `av_cache` | 2,977 | 32,194,560 | Provider cache candidate; verify all cache readers/expiry behavior |
| `llm_council_runs` | 4,714 | 31,907,840 | Council history; archive only if UI/API historical readers can retrieve it |
| `llm_council_batches` | 4,721 | 29,237,248 | Parent/child integrity with council runs and jobs required |
| `provider_call_ledger` | 6,383 | 28,237,824 | Spend/audit ledger; immutable and queryable retention required |
| `agent_signals` | 19,005 | 26,222,592 | Active research outputs; retain hot query paths and ordering semantics |
| `edge_signals` | 4,690 | 24,657,920 | Research evidence; dependency and lineage checks required |
| `edge_signal_inputs` | 4,690 | 23,748,608 | Must migrate with parent edge signals and preserve references |
| `pipeline_stage_events` | 1,474 | 22,577,152 | Audit/event history; preserve append-only semantics |
| `llm_council_model_forecasts` | 11,486 | 19,759,104 | Council history; preserve run/model key relationships |
| `llm_council_turns` | 4,726 | 12,935,168 | Council history; preserve ordering and parent run links |
| `llm_council_jobs` | 9,478 | 11,870,208 | Background-job state; do not split from lifecycle behavior without an outbox plan |
| `evidence_evaluation_details` | 555 | 11,460,608 | Evaluation provenance; linked retention required |
| `evidence_cache_v2` | 2,512 | 11,370,496 | Cache candidate; apply explicit expiry and readers-first validation |
| `newsletters` | 249 | 8,421,376 | Owner content; preserve complete text and attachment references |

\* The live estimate for `symbol_daily_returns` is stale/inconsistent with the earlier exact 261,678-row cohort count; do not use it as an export count. Its separate archive status is `loading`, with readers disabled, according to the existing work log.

The top 20 relations occupy about 634.4 MiB (664,961,024 bytes); their storage alone exceeds one D1 Free database's 500 MB ceiling. This makes wholesale placement in one D1 database impossible without measured reduction or a reviewed split. Multiple D1 databases have no cross-database transactions or foreign keys, so the split must follow bounded domains, not arbitrary table size.

## First implemented slice

`user_watchlist` is currently empty in Supabase. The staging D1 table has the same key constraints and owner-scoped list/add/remove gateway operations. The app still authenticates through Supabase and enriches watchlist results from Supabase `agent_signals`, so this slice proves only the gateway contract; it does not restore app login or make the overall database Cloudflare-authoritative.

## Backup evidence and outstanding source of truth

The local `kairos_2026-11-16_005523.dump` is 139,184,485 bytes. `pg_restore --list` identified a PostgreSQL 17.6 custom-format archive with 3,174 TOC entries. It has been restored into an isolated loopback PostgreSQL 17 cluster, but the restore is only partially compatible and is not yet reconciled to live source schema/policies/triggers. Do not read credential stores or treat the 132.7 MiB archive as restored database size.

## Isolated local restore checkpoint — 2026-11-17

The dump was restored into a separate PostgreSQL 17 cluster listening only on loopback, with Supabase roles created locally. Restore summary:

| Measure | Local restore | Live source snapshot | Interpretation |
|---|---:|---:|---|
| Public tables restored | 270 / 274 | 274 | The four missing tables use `extensions.vector` |
| Exact rows across restored tables | 1,583,520 | 433,273 earlier planner estimate | The prior estimate is not an exact row count and materially understates this backup |
| Database size | 973,076,147 bytes | 829,271,187 bytes | The restore is a local accounting snapshot, not the source metric or D1 sizing result |
| Public tables with RLS | 270 / 270 | 274 / 274 | RLS flags restored for all 270 tables that could be created |
| Policies | 198 | 204 | Six policy definitions were not restored because of unavailable Supabase extensions/objects |
| Non-internal public triggers | 166 | 236 | Trigger parity is not established; missing extension functions account for restore failures |
| Public functions | 149 | 155 | Function parity is not established |

The four tables not restored are `agent_memory`, `doc_chunks`, `trade_decision_embeddings`, and `trade_memories`. A same-day read-only live query returned zero rows for each, but those source counts do not replace a complete restore receipt. The local restore reported 96 SQL errors, including unavailable `pg_cron`, `pg_net`, `supabase_vault`, and `vector` extensions; do not treat it as the final migration input until remaining data/schema omissions are explicitly reconciled.

The restored snapshot's largest relations are `price_cache_restatements` (110,870,528 bytes), `decision_observations` (76,537,856), `symbol_daily_returns` (74,784,768), `research_packets` (59,998,208), `observation_labels` (45,932,544), and `price_cache` (45,490,176). The numbers differ slightly from the live inventory because this is a Nov 16 dump and a local PostgreSQL restore.

The local loopback cluster is now queryable using its local bootstrap role; its `pg_hba.conf` allows trust only for loopback, and the server listens only on `127.0.0.1:55441`. The role adjustment was made in that isolated restore only. A fresh exact scan of its 270 public tables still totals 1,583,520 rows; public relation sizes sum to 948,715,520 bytes and the database is 971,683,507 bytes. The full 270-table exact-count/size inventory stays under the owner-local `Kairos\migration-restore\2026-11-17\public-table-inventory.csv`, not in the repository.

## Read-only production reconciliation — 2026-11-17 21:17 UTC

Supabase MCP direct SQL is currently available for read-only metadata queries even though the app's Supabase REST path was previously returning quota errors. Current database size is 829,328,531 bytes, with 274 public tables and 800,972,800 public relation bytes. Exact counts for the largest relations show the Nov 16 dump is still representative for most live hot tables, but four cohorts changed after the dump and must use their independent verified R2 archive receipts rather than be re-imported from stale local rows:

| Table | Local Nov 16 rows | Current source rows | Current source bytes | Handling |
|---|---:|---:|---:|---|
| `price_cache_restatements` | 365,750 | 0 | 32,768 | Already archived and pruned; use the checksummed R2 archive/read path |
| `evidence_records` | 77,167 | 0 | 40,960 | Already archived and pruned; use the checksummed R2 archive/read path |
| `dimension_diagnostic_findings` | 22,938 | 1,571 | 2,662,400 | Latest 36 runs retained; 21,367 cold rows already archived |
| `india_news_snapshots` | 8,982 | 650 | 1,425,408 | Seven-day hot window retained; 8,332 old rows already archived |

Other queried high-size tables match the local restore counts, including `symbol_daily_returns` (261,678), `decision_observations` (18,515), `research_packets` (18,754), `observation_labels` (45,424), `price_cache` (190,358), `signal_score_history` (18,559), and `agent_signals` (19,005). This is scoped parity evidence for the listed tables, not a fresh full-database export or a complete current backup. No source rows were changed by these read-only probes.

## Current Cloudflare storage checkpoint — 2026-11-17

- Cloudflare R2 account metrics report 83 Standard objects, 189,155,223 payload bytes, and 3,044 metadata bytes: 189,158,267 conservative observed bytes, well below the app's 8,000,000,000-byte hard stop. This is a read-only metrics snapshot; the guard still needs to run before each upload path.
- The already-open Cloudflare D1 dashboard is authenticated to the same account and currently labels the D1 Free quotas directly: 2/10 databases, 496.74k/5M daily rows read, 99.02k/100k daily rows written, 25.35 MB/5 GB storage. The D1 GraphQL analytics API independently returned 496,715 rows read and 99,001 rows written for `kairos-history-archive` on Nov 17, and 28/18 for `kairos-app-staging`. This confirms essentially no write headroom remains today; do not import another chunk before 00:00 UTC and a fresh usage check. Analytics also reports 198,014 rows written to the archive database on Nov 16, which is above the published Free daily allowance and requires reconciliation against Cloudflare's UI/plan accounting before relying on bulk import as a repeatable always-free operation. No further remote D1 writes were made during this review.
- D1 API metadata reports `kairos-app-staging` at 40,960 bytes and `kairos-history-archive` at 25,313,280 bytes. The app staging D1 contains only the watchlist schema/migration ledger and no imported user rows; do not treat it as the app database.
- Read-only D1 SQL API check on `kairos-history-archive` returned dataset `symbol_daily_returns_v1` in `archive_dataset_status`: 99,000 verified rows of 261,678 expected, `loading`, daily mirror counter 0. The physical destination table is named `symbol_daily_returns` and also has exactly 99,000 rows; its schema has 14 columns and two secondary indexes (`symbol_daily_returns_market_date_idx`, `symbol_daily_returns_lookup_idx`). Database size remained 25,313,280 bytes. Status/count/schema/index queries wrote zero rows. The previous check queried the dataset key as a table name and therefore did not actually inspect the archive; this corrected check validates the intended destination table.
- Rebuilt the remaining 162,678-row archive import plan with two indexed columns and a 20,000-row/day cap: nine chunks, first eight at an estimated 60,000 D1 writes/day, final chunk 8,034, leaving at least 40,000 daily write headroom. This is a local plan only; start a chunk only after checking that UTC day's actual account-wide quota. The previous 72,678-row single-day queue is not quota-safe under indexed-write accounting.

## Required next inventory work

1. Reconcile the partial restore's 4 missing tables and six policy/70 trigger/6 function differences against the verified live inventory; identify which are genuinely empty/extension-only and export exact counts and ordered digests where needed. Reconcile all four already-archived cohorts using their independent manifests and do not import their stale pre-prune copies.
2. Export primary/foreign keys, indexes, RLS policies, triggers, functions/RPCs, extensions, and scheduled jobs from the restored snapshot and compare with live metadata.
3. Generate a dependency graph from SQL migrations and all static/dynamic query call sites, then define bounded D1 application domains based on measured SQLite sizes. D1 Free requires staying below 400 MB/database as the project warning threshold, below 5 GB/account, and within the 100,000 daily row-write quota; cold R2 data must have tested app readers and cannot replace relational query capability by itself.
4. For each proposed archive or D1 cohort, implement a typed online reader and verify row counts, ordered digests, cold reads, and restore before disabling any source reader or deleting source rows.

No Supabase rows were changed or deleted by this inventory.
