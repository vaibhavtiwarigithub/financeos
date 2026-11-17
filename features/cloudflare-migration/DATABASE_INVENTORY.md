# Cloudflare migration database inventory

**Snapshot:** 2026-11-17. Read-only Supabase SQL/MCP and repository scan. This is an inventory checkpoint, not a migration or cutover approval.

## Source database size

| Measure | Value | Notes |
|---|---:|---|
| Postgres database size | 829,271,187 bytes (790.7 MiB) | `pg_database_size(current_database())` |
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

The relation-size sum is lower than the database-size result because database-wide catalogs, schemas, and other allocations are not represented by the summed public relations. Neither measure is the compressed dump size.

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

The local `kairos_2026-11-16_005523.dump` is 139,184,485 bytes. `pg_restore --list` successfully identified a PostgreSQL 17.6 custom-format archive with 3,174 TOC entries. It has not been restored, reconciled against the live source, or proven complete. The local PostgreSQL 17 Windows service is running, but connecting as the current OS user fails because no local database password is supplied. Do not read credential stores or treat the 132.7 MiB archive as restored database size.

## Required next inventory work

1. Restore the custom dump into a newly named isolated PostgreSQL database using an owner-provided local credential or a verified local authentication route; never restore over a production database.
2. Export exact counts, primary/foreign keys, indexes, RLS policies, triggers, functions/RPCs, extensions, and scheduled jobs from that restored snapshot.
3. Generate a dependency graph from SQL migrations and all static/dynamic query call sites, then select the first non-trading vertical slice with a useful authenticated write path.
4. For every proposed archive cohort, implement a typed online reader and verify row counts, ordered digests, cold reads, and restore before disabling any source reader or deleting source rows.

No Supabase rows were changed or deleted by this inventory.
