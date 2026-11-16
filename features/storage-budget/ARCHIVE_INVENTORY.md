# Kairos R2 archive inventory

Last verified: 2026-11-16 (UTC). Bucket: private Standard R2 `kairos-cold-archive`; public `r2.dev` domain disabled.

## Full recovery backup

`full-db-backup/2026-11-16/` contains the two verified PostgreSQL 17 custom-dump parts and its full-backup manifest. The combined 139,184,485-byte dump was restored into an isolated PostgreSQL 17 instance, passed `pg_amcheck` over 2,057 relations / 117,158 pages, and matched stable row-count digests for 274 public and 316 application-schema tables. Combined object size including manifest: 139,185,553 bytes.

## Table archive candidate: `public.price_cache_restatements`

| Field | Value |
|---|---|
| R2 object | `table-archives/2026-11-16/price_cache_restatements.dump` |
| R2 manifest | `table-archives/2026-11-16/price_cache_restatements_manifest.json` |
| R2 prune receipt | `table-archives/2026-11-16/price_cache_restatements_prune_receipt.json` |
| Format | PostgreSQL custom, data-only; restore requires the existing full Kairos schema and trigger dependencies |
| Rows | 365,750 |
| ID range | 3–365,769 |
| Date range | 2021-09-27–2026-11-11 |
| Maximum detection timestamp | 2026-11-12 14:00:25.804524 UTC |
| Payload size | 18,430,981 bytes |
| SHA-256 | `DACD94F4EBB276B665C4C65F87095BC15A989CE793D0F34A3B695EA91756530A` |
| Round-trip | Downloaded from private R2; exact SHA-256 and byte count match the local restore-tested source |
| Production rows removed | Yes; exact archived table cleared on 2026-11-16 after locked count/bounds/size check |

The data-only archive is preservation evidence; the live append-only table remains in place for new restatement events. Its historical 365,750 rows were removed only after the live exact count, ID/date bounds, latest event timestamp and 118,857,728-byte relation size matched under an ACCESS EXCLUSIVE lock; the live code/view/function audit found no consumer or inbound FK. The truncate freed 118,824,960 database bytes and left the relation at 32,768 bytes. The append-only trigger writer remains enabled. Older rows can be recovered by restoring the private R2 archive into the full Kairos schema; Kairos has no direct app reader for this ledger, so application queries do not need a new runtime adapter for this pilot.

## Table archive: `public.evidence_records`

| Field | Value |
|---|---|
| R2 object | `table-archives/2026-11-16/evidence_records.sql.gz` |
| R2 manifest | `table-archives/2026-11-16/evidence_records_manifest.json` |
| Restore receipt | `table-archives/2026-11-16/evidence_records_restore_receipt.json` |
| R2 prune receipt | `table-archives/2026-11-16/evidence_records_prune_receipt.json` |
| Format | gzip-compressed PostgreSQL `COPY` SQL, data-only; restore into the table from the full Kairos schema |
| Rows / IDs | 77,167 rows; IDs 1–77,181 |
| Retrieved-at range | 2026-07-02 14:02:27.42–2026-11-12 14:01:50.793 UTC |
| Ordered row-content digest | `11914f224f4bb296a132bfaa0ea483e0` |
| Compressed bytes / SHA-256 | 2,627,533 / `61E6C4C01B512FF3F28894459D4E723B867B0C4CC56C16111CCC2FA29406A99C` |
| R2 round-trip | Archive, manifest, restore receipt, and prune receipt downloaded; each SHA-256 matched its source |
| Restore proof | R2-downloaded archive restored into a clean PostgreSQL 18 table; row count, ID/date bounds, and ordered content digest matched production pre-prune |
| Production rows removed | Yes; exact count, bounds, and digest asserted under an ACCESS EXCLUSIVE lock on 2026-11-16 |

The reader audit found no application reads, SQL view/function reads, or FK references; the sole trigger is the enabled append-only `BEFORE DELETE OR UPDATE` guard. New evidence writes remain enabled. Archived records are not directly queryable through Kairos until restored into Postgres; this is a cold restore path, not an online R2 query adapter.

## Table archive: cold `public.dimension_diagnostic_findings`

| Field | Value |
|---|---|
| R2 object | `table-archives/2026-11-16/dimension_diagnostic_findings_cold.csv.gz` |
| R2 manifest | `table-archives/2026-11-16/dimension_diagnostic_findings_manifest.json` |
| Restore receipt | `table-archives/2026-11-16/dimension_diagnostic_findings_restore_receipt.json` |
| R2 prune receipt | `table-archives/2026-11-16/dimension_diagnostic_findings_prune_receipt.json` |
| Format | gzip-compressed CSV with header and PostgreSQL-native field values |
| Rows / IDs | 21,367 cold findings; finding IDs 1–21,367, linked to diagnostic runs 1–692 |
| Created-at range | 2026-08-06 22:01:43.386017–2026-11-02 23:25:09.601705 UTC |
| Ordered row-content digest | `83d4ed4856c130156347bcaf3de43aa5` |
| Compressed bytes / SHA-256 | 2,490,557 / `ABA8B135A9609B5863966CBBDD7F485CCE37088CFB39EFC93C8BAEAB5F0740566` |
| R2 round-trip | Archive, manifest, restore receipt, and prune receipt downloaded; hashes matched; downloaded archive restored and digest-checked |
| Retained live context | 1,571 findings for the latest 36 `dimension_diagnostic_runs` per market; post-prune ordered digest `a5685c828876bde1a7ddc80c8e26970a` matched pre-prune |
| Production result | Removed only after a locked exact count/ID/content digest assertion; append-only trigger re-enabled; parent runs and RESTRICT FK retained |
| Physical reclamation | Relation fell from 39,870,464 to 2,629,632 bytes after `VACUUM FULL (ANALYZE)`; database fell from 934,849,683 to 897,617,043 bytes |

The dashboard endpoint reads the newest 8 diagnostic runs; the measure-only improvement context reads the newest 36 runs per market. The run headers remain online, and all findings required by those readers remain online. Older findings are privately recoverable but require cold restoration into PostgreSQL; R2 is not a SQL reader.

## Table archive candidate: `public.symbol_daily_returns` (preserved; not pruned)

| Field | Value |
|---|---|
| R2 objects | `table-archives/2026-11-16/symbol_daily_returns_data.sql.gz`, `symbol_daily_returns_schema.sql`, and `symbol_daily_returns_manifest.json` |
| Format | gzip-compressed PostgreSQL `COPY` SQL plus table DDL excerpt; restore data into the existing schema from the full Kairos backup/migrations |
| Rows / IDs | 261,678; IDs 1–4,256,041 |
| Session date range | 2017-02-23–2026-11-11 |
| Ordered digest | `846c84ce7217a485a509e13cc3539921` (per-row JSON digests concatenated in ID order) |
| Compressed data bytes / SHA-256 | 9,173,390 / `81ba0e1ea58cb879735594769666b7df85204981739907ca9d178b706769b1d2` |
| Table DDL excerpt SHA-256 | `c5ba8510fac7601db5903a0a8024b432006642028a65b22faedf5dbce65ca4c5` |
| Source snapshot | Verified full PostgreSQL 17 dump `kairos_2026-11-16_005523.dump`, SHA-256 `3cdf727aab5abd4e71091a9089e19870d3faec9dce9e6b3becfed896d23087e8` |
| Restore proof | Source extraction and an independent private-R2 download were restored to clean local PostgreSQL databases; both matched the live count, ID/date bounds, and ordered digest |
| Production rows removed | No; five application readers and one SQL RPC use this history |

This proves independent preservation and restore integrity, but it is not a runtime R2 query adapter. The live relation remains intact until every active reader has a tested way to obtain moved history.

## Supabase maintenance log cohort: `cron.job_run_details` older than seven days

| Field | Value |
|---|---|
| R2 objects | `table-archives/2026-11-16/cron_job_run_details_older_7d.csv.gz` and `cron_job_run_details_older_7d_manifest.json` |
| Format | gzip-compressed CSV; restored and verified in a clean local PostgreSQL table |
| Rows / run IDs | 41,152; IDs 1–41,212 |
| End-time range | 2026-06-29 20:30:00.167960–2026-11-09 06:55:00.078621 UTC |
| Exclusive cutoff | 2026-11-09 06:57:58 UTC (seven days before the source snapshot) |
| Ordered row digest | `8716a086096392bd41e154466c4b07b3` |
| Compressed bytes / SHA-256 | 991,052 / `b6c6edaa76fba3264552a8aa915aa480e0e55136de42a455e837191ba90cfe02` |
| Restore proof | Local snapshot extraction and a fresh R2 download each restored with 41,152 rows, the same bounds, and the same ordered digest |
| Production effect | Exactly these 41,152 logs deleted under a count/bounds/digest-gated SQL statement; no scheduled jobs changed or disabled |
| Ongoing retention | Daily pg_cron job `kairos-cron-history-retention-7d` retains at least seven days and removes older run history |

Supabase documents that pg_cron run history is not cleaned automatically and recommends a rolling seven-day cleanup. Old operational logs remain recoverable from private R2. This retention does not prune Kairos research, trade, position, or council data.

## Capacity

The latest verified R2 inventory is 189,155,223 payload bytes across 83 private objects (189,835,159 bytes with the conservative 8,192-byte-per-object allowance), below the 8 GiB hard stop by a wide margin. This includes the verified `symbol_daily_returns` preservation objects, seven-day cron-log archive, and India news snapshot cohort below. Account metrics may lag; use R2 object inventory and the local capacity guard before every upload. Never enable public bucket access or auto-delete objects to enforce the cap. Receipts are immutable and separate from archive manifests, which record source state at export time.

## India news snapshot cohort older than seven days

| Field | Value |
|---|---|
| R2 objects | `table-archives/2026-11-16/india_news_snapshots_7d/india-news-snapshots-before-2026-11-09T113654Z.csv.gz`, `manifest.json`, and `prune-receipt.json` |
| Format | gzip-compressed CSV with header and native PostgreSQL field values |
| Source snapshot | Verified PostgreSQL 17 full dump `kairos_2026-11-16_005523.dump`, SHA-256 `3cdf727aab5abd4e71091a9089e19870d3faec9dce9e6b3becfed896d23087e8` |
| Source table proof | All 8,982 rows, IDs 1–8,982, and whole-table ordered digest `46e507d5f08f212210969901ff76b6b5` matched the current production table before pruning |
| Cohort | 8,332 rows; IDs 1–8,332; fetched 2026-10-13 13:51:01.29705–2026-11-09 02:45:30.841024 UTC; cutoff exclusive at 2026-11-09 11:36:54 UTC |
| Ordered row digest | `80bff5cb61b3ad12093a1215eb340c32` |
| Compressed bytes / SHA-256 | 6,305,026 / `ea5f06d372446f81c5e1c2553e3eec2eb97b7ce3763b2ffbc7fdddb7f4372f28` |
| Restore proof | Decompressed CSV hash matched; loaded into a separate local PostgreSQL 17 table with 8,332 rows, the same bounds and ordered digest; R2 archive and manifest downloads matched local SHA-256 |
| Production effect | Exact archive count, bounds and digest rechecked in the bounded `prune_archived_india_news_snapshots` RPC. Exactly 8,332 expired rows removed; 650 recent rows (IDs 8,333–8,982) and append-only trigger remain |
| Physical reclamation | Relation reduced from 20,152,320 to 1,425,408 bytes; whole DB reduced from 847,170,707 to 828,443,795 bytes after `VACUUM (FULL, ANALYZE)` |
| Prune receipt | R2 `prune-receipt.json`; SHA-256 `3eda8b68792e5aea7626a7f4b7d503f8bf84e76f7f13968b410e926d215f103e` |

The only current batch consumer scans the preceding seven days; the application source audit found no other direct reader, SQL view/function reader, or foreign-key dependency. The table's append-only trigger remains enabled. The database function rejects unexpired or oversized cohorts and refuses deletion unless current count, ID bounds, and ordered digest match. Ongoing automatic R2 archiving for future cohorts is still a required implementation item; this one-time verified prune does not establish automatic retention.
