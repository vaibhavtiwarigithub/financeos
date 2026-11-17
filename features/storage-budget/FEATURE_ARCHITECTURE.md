# Storage budget and recoverable cold archive — implementation record

Current design: [COLD_ARCHIVE_MIGRATION_ARCHITECTURE.md](COLD_ARCHIVE_MIGRATION_ARCHITECTURE.md). The owner approved the broader goal of privately archiving relevant historical data and reducing Supabase below 400 MB. Codex is Architect and Builder. This document contains earlier November 10 discovery/proposal history; use the linked detailed design and current-state files for active requirements.

**Current state (2026-11-16 09:36 UTC):** the full Supabase PostgreSQL 17 dump and verified table/cohort archives are stored in private R2. Three no-reader/reader-window-bounded histories were pruned after exact restore and membership checks; stale cache rows were removed under their documented expiry rules. A further `symbol_daily_returns` archive (261,678 rows) was independently restored from R2 but not pruned because five TypeScript readers and one RPC use it. Supabase pg_cron's official seven-day run-log retention was applied: 41,152 archived rows were removed, a daily retention job was scheduled, and `VACUUM FULL` reduced `cron.job_run_details` from 12,328,960 to 1,335,296 bytes. All 139 scheduled jobs are active, including the new retention job. Content-preserving compaction and prior cleanup leave the live DB at **847,129,747 bytes**, still writable and above the 400 MB target and 500 MB Free quota. R2 has 19 private objects totaling 172,911,071 bytes. Cold records can be restored into Postgres; no online R2 query adapter exists. Active-history reader support, broader safe reclamation, and a live production size monitor remain incomplete.

## 1. User intention

Keep the FinanceOS production database below 400 MB, with warning and corrective action before the 500 MB Free-plan quota, while retaining restorable research and financial evidence at zero new paid spend.

## 2. Current architecture

Supabase Postgres is the transactional source for auth, research, price, decision, and trading records. Vercel runs the existing db-cleanup route. A local `pg_dump` script exists, but the only observed local dumps are two zero-byte July files; restore is unverified. On 2026-11-10 production database size was about 1.55 GB, `av_cache` about 580 MB. Existing safe retention candidates total about 211 MB row-data; 7-day candle-cache candidates overlap the 30-day cache candidates. Cache expiry alone cannot reach 400 MB. The November 15 Free-plan grace deadline is a separate billing risk from the 95%-disk read-only condition.

## 3. Proposed architecture

1. Keep current transactional and recent queryable data in Supabase. Do not split an active transaction across databases.
2. Use the existing cleanup job daily for explicitly disposable provider cache and already-approved safe retention windows. Report any failed step as degraded health.
3. Measure database size, table/index size, daily growth and projected days to 400/500 MB on each natural daily health cycle. Warn at 350 MB; treat 400 MB as a budget breach requiring operator action. Do not label the system healthy merely because cleanup ran.
4. Use Cloudflare R2 Standard as a private cold archive destination for the existing, locally verified provider-cache archive. Upload the compressed archive, manifest, and PostgreSQL restore receipt under immutable checksum-addressed keys; download and verify the exact bytes and row digest before claiming remote backup. Keep an independently restorable full database backup as well. Broader historical cohorts require table-specific design and approval. Only after both proofs may an approved cohort be pruned from production.
5. Preserve append-only financial ledgers, current positions/orders, score and decision provenance, labels needed for forward evaluators, and the point-in-time inputs required by active backtests. Archival eligibility must be specified table by table and respect their read paths and retention requirements.
6. Reclaim Postgres space using the supported recovery procedure; verify actual `pg_database_size` and disk percentage after maintenance. Verify the Free-plan quota separately.

## 3a. Cache read-path audit, November 10

The shared `av_cache` has no reader that searches historical daily copies: `providerCachedFetch` reads today's exact slot or the newest slot per key, while the direct market-status and earnings-capability readers read today's slot and the corporate-action readers read the newest slot. The longest raw provider fresh window found is 30 days (Finnhub profile and corporate actions); ordinary failure fallback is at most 7 days, and intraday Alpaca quote/activity callers disallow stale fallback. Production contains 58,860 cache rows: 12,803 newest-per-key rows (~133 MB payload) and 46,057 superseded rows (~335 MB payload). These are payload sizes, not reclaimable database bytes. `evidence_cache_v2` is a separate current-snapshot cache (~21 MB total table size) with a 45-day ceiling for reported fundamentals; `india_screen_cache` is ~1.7 MB and research requires a row refreshed within 36 hours. `price_cache` (~63 MB) and `price_cache_restatements` (~109 MB) are historical price/provenance evidence, not disposable provider response cache. This audit supports retaining one newest raw response per key until its caller-specific age limit, with a conservative global 30-day cap. A superseded-row policy needs a verified archive/restore and measured natural-run acceptance before production pruning. The current 7/30-day cleanup is narrower and already owner-authorized.

Cloudflare D1 Free currently caps each database at 500 MB and the account at 5 GB; it cannot directly host the current 1.55 GB Postgres database or its Postgres functions/RLS. Cloudflare R2 Standard offers 10 GB-month of free object storage and is the candidate for cold archives, subject to an account/bucket access path and a no-spend guard. Source: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## 4. User journey / system flow

The owner sees actual size, daily growth, days to threshold, last successful cleanup/backup/restore proof, and any blocked archive cohort in System Health. Research and trading keep using Supabase. Historical evidence remains retrievable from its manifest and archive through a controlled restore workflow.

## 5. UI / API / data / interaction model

Reuse System Health and the existing cleanup route. No new public route is assumed. Archive manifests and access control are design decisions before implementation; no bucket, credential, schema, or client access is created by this proposal. Large raw payloads should not enter an owner-facing response.

## 6. States and edge cases

- Archive unavailable, quota exceeded, export incomplete, hash mismatch, count mismatch, restore failure, or missing manifest: keep source rows and show degraded status.

## 7. November 16 implementation addendum

**Recurring India snapshot archive status (2026-11-16 15:45 UTC):** the guarded future-cohort path is integrated into the existing daily cleanup job. Production has `get_india_news_snapshots_archive_candidate(timestamptz)` and `get_database_storage_report()`; only `service_role` can execute either. The live Worker `kairos-history-reader` is deployed on `workers.dev` with D1 and private R2 bindings and a bearer secret; an unauthenticated archive read returned HTTP 401. D1's per-day mirror-budget columns and first lookup index are live; their actual metering was 99,001 row writes for the index operation. A read-only verification found 99,000/261,678 imported rows and zero writes, with D1 at 21,794,816 bytes. Stop D1 writes for this UTC day; remaining work requires the second index on a later quota day, source import, full parity, live mirror and consumer tests. Vercel rejected creating runtime variables with HTTP 402 (`resource_creation_blocked`, team fair-use limit); the Vercel CLI fallback requires a new interactive login. Thus no authenticated Worker status check or scheduled production archive cycle is verified yet. Supabase measured 828,607,635 bytes at 15:45 UTC and remained writable; under-400 MB remains incomplete.

The owner approved the broader archive and storage-reduction work on November 16. The detailed, current status and exact D1 quota-day sequence are maintained in [COLD_ARCHIVE_MIGRATION_ARCHITECTURE.md](COLD_ARCHIVE_MIGRATION_ARCHITECTURE.md); that document supersedes this proposal's earlier statement that D1 was excluded. Current state: Supabase remains the only enabled app data source at 847,203,475 measured bytes; D1 contains 99,000 of 261,678 source rows and is not marked verified; private R2 currently holds 80 objects / 182,848,115 payload bytes. All six daily-return read paths have tested opt-in adapters but remain disabled. No app runtime is configured to read from D1, and no further daily-return source rows were pruned. The target remains below 400,000,000 bytes, so recovery is not complete.
- Backup unavailable or zero bytes: block durable-data deletion.
- A cohort still used by live evaluators, active backtests, or financial reconciliation: keep queryable source rows.
- Cache cleanup succeeds but database remains over 400/500 MB: report the measured breach, never infer compliance from deleted-row counts.
- Daily growth exceeds available headroom between checks: alert on projected breach; a schedule cannot guarantee a hard ceiling without ingestion budgets or a fail-closed admission policy for nonessential data.

## 7. Files that may be touched later

`app/api/agents/db-cleanup/route.ts`, existing System Health read paths, `scripts/backup-db.ps1`, a bounded archive/restore script, relevant `docs/arch/` chapters, `WORK_LOG.md`, and `public/agent-diagrams/system-map.json` if data flows change. Any new schema or access boundary requires its own migration and review.

## 8. Risks / decisions needed

The owner approved the durable archive direction. Wrangler OAuth is available and the private bucket is operational. The full database backup and first table-level archive/reclamation are recorded in [ARCHIVE_INVENTORY.md](ARCHIVE_INVENTORY.md). The detailed production table/readers audit is in [HISTORICAL_READER_AUDIT_2026-11-16.md](HISTORICAL_READER_AUDIT_2026-11-16.md). R2 Free usage is limited to 10 GB-month Standard storage and operation quotas; exceeding those requires a stop, never automatic paid spend. Remaining gates are a tested application read/restore path for active historical tables, bounded recurring archiving, a live monitor, and further measured physical reclamation. A hard promise to stay below 500 MB is impossible while essential data can grow without a bounded write budget.

## 9. Acceptance criteria

Production is writable; a nonzero full backup restores into an isolated database; an archive cohort restores with exact row counts and checksums; active read paths and evaluators continue to work; actual database size falls below 400 MB; daily monitoring reports size and projected threshold crossings; natural cleanup runs succeed; no account, trading, score, or historical financial record is altered.

## 9a. Cache-only R2 transfer implementation, November 10

`scripts/r2-cache-archive.mjs` accepts the existing owner-protected provider-cache archive directory and a private R2 bucket. It re-verifies the manifest and local PostgreSQL restore receipt, requires a measured `KAIROS_R2_VERIFIED_FREE_HEADROOM_BYTES` greater than the complete upload size, uses Wrangler's explicit `--remote` setting, downloads every object, verifies hashes and row count, and writes a local receipt only after the round trip succeeds. It has no database write or R2 delete command. Its 13 focused archive tests pass. Wrangler OAuth completed on November 10, but `r2 bucket list` returned Cloudflare code 10042 (`NotEntitled`): this account has no R2 subscription. Cloudflare requires an account checkout before R2 use, with billing beyond the included free monthly allowance. Under the owner's no-paid-services constraint, R2 enrollment and production upload remain blocked pending an owner account decision. The existing local archive remains intact. This cache-only backup is not a full database backup and cannot authorize durable-data pruning.

## 9b. Emergency disposable-cache recovery, November 10

After the owner explicitly authorized clearing fresh as well as expired raw provider responses, a single `BEGIN READ WRITE` transaction truncated only `public.av_cache` with a five-second lock timeout and no cascade. Immediately before the operation, the table had 58,994 rows, occupied 608,018,432 bytes, and had no inbound foreign keys or custom triggers. Verification afterward showed zero rows, a 24,576-byte table, and database size reduced from 1,646,013,587 to 1,038,019,731 bytes. At 2026-11-11 03:48 UTC a new session reported both `default_transaction_read_only` and `transaction_read_only` off, with database size 1,038,027,923 bytes. Natural scheduled write persistence and the billing-period quota still require separate verification. The existing local archive covers an older subset only; fresh cache will be refetched subject to provider budgets. No durable research, score, label, position, order, or trade table was changed. This does not achieve the 400 MB target or necessarily clear the billing-period average quota.

The existing `scripts/backup-db.ps1` passed a password-bearing URI to `pg_dump` on the command line and wrote dumps under the OneDrive workspace. It now passes the password only through libpq's child environment, validates the FinanceOS target, stores dumps in an explicit current-user-only local directory, verifies archive structure, and avoids automatic deletion of earlier backups. Three focused tests, the 4,790-test app suite, TypeScript, and changed-file secret scan passed. The fix is on main `2297dbbd1750a0b8f3ebf354a5a5539cfc6262b5`, and Vercel production deployment `dpl_84BdSpKiS6WgY3kk9xvF4ADhFEzW` was READY; `/login` returned HTTP 200. The owner's claimed `SUPABASE_DB_URL` update is not yet visible in the exact ignored `.env.local` file: its one matching line still contains `[YOUR-PASSWORD]`, so no full dump or full restore proof exists. The backup script fails closed without printing the value. The natural 2026-11-11 04:00 UTC `kairos-watchdog` tick produced a newer `evolution_supervisor` row, status `done`, state `attention`, no read failures. Its queue increased from 14 to 20 after the outage, including missed Nov 10 label, benchmark, and US evidence runs and a critical US price-cache freshness breach. No route was manually invoked, and those missed producers and freshness conditions are not marked resolved.

## 10. Approval gate

The cache archive direction was approved November 10. On November 16 the owner explicitly approved the expanded historical-data archive and sub-400 MB objective and directed Codex to complete it without repeated approval prompts. That authorization does not permit public R2 access, use of existing secrets, paid services, or changes to trading/score/position/broker state. Each data cohort still must pass the documented archive, exact-membership, restore, and reader checks before it is removed.

## 11. Available-access follow-through, November 10

The owner asked to continue without another database-password request. Supabase's current Free-plan documentation states that automatic and downloadable dashboard backups are not included; its manual CLI dump still requires the database password. The connected SQL tool is useful for diagnosis but is not a consistent, restorable full export. No browser credential, environment secret, or provider key was read to work around this.

At the 2026-11-11 04:02 UTC read-only check, `pg_database_size` was 1,038,961,811 bytes, default read-only was off, and 40 new provider-cache rows had appeared through natural activity. Even removing all cache leaves roughly 1.04 GB online, so the requested sub-400 MB target needs at least about 639 MB more physical reduction. The largest remaining relations are durable price/provenance, daily-return, decision, and research evidence. `price_cache` has estimated dead tuples, but their count does not prove reclaimable bytes or justify disruptive maintenance without a full restore proof.

The existing daily cleanup truthfully reports a failed `agent_signals` orphan step. Its code calls `delete_orphaned_agent_signals`, while a production `pg_proc` lookup and repository migration search found no such function. Other cleanup steps can still run; the alert must remain open. Adding a deletion RPC changes the schema and historical evidence retention, so it is outside this cache-only recovery and cannot serve as a shortcut to the quota target. The US price-cache freshness alert and missed Nov 10 producers also remain open for the next natural market-local runs. No manual research, trading, prewarm, or watchdog route was invoked.

Primary sources: [Supabase Free-plan backup FAQ](https://supabase.com/kb/faqs/platform/free-plan-backups), [database backup guide](https://supabase.com/docs/guides/platform/backups), and [current Free-plan limits](https://supabase.com/pricing).


## November 12 prospective growth fix

Migration `20261112165022` keeps the stored close when an adjusted Yahoo bar
older than 60 UTC days differs only by less than one part per million. The
trigger compares against the stored close on each write and keeps the original
discovery timestamp. Changes at or above the threshold, recent bars, other
providers, changes in volume or other prices, and provenance changes retain
their previous behavior. Existing audit rows are preserved.

A read-only production sample found 9,427 matching close-only events among
11,328 same-basis Yahoo events after November 11 06:00 UTC. This is a count of
historical matches. It does not measure future space savings. Production
database size was 1,098,787,987 bytes after application. The full backup
connection remains a template and the durable archive and restore remain
pending. The 400 MB target and November 15 billing grace deadline still apply.


## Durable cold-archive proposal (November 16, 2026)

Detailed design and review gate: [COLD_ARCHIVE_MIGRATION_ARCHITECTURE.md](COLD_ARCHIVE_MIGRATION_ARCHITECTURE.md). The owner later approved the broader archive/reduction objective; current archive and prune receipts are listed in [ARCHIVE_INVENTORY.md](ARCHIVE_INVENTORY.md), and active readers/cohort boundaries are tracked in [HISTORICAL_READER_AUDIT_2026-11-16.md](HISTORICAL_READER_AUDIT_2026-11-16.md).

## 2026-11-16 implementation status

The owner approved the detailed database-first design with “go”. The full backup and three pruned data archives are verified as described above. Two no-reader histories and one reader-window-bounded diagnostics cohort were safely reclaimed, with append-only protections retained. A 1,205-row expired evidence-cache cohort was removed and verified; content-preserving compaction brought production to 858,123,411 bytes at 09:20 UTC, still writable. A further `symbol_daily_returns` archive is restore-verified in R2, with no source pruning due to active readers. The branch contains a review-only service-role storage-report RPC and daily cleanup-route integration; migration and app code are not deployed, so production monitoring and recurring cache cleanup are not active. An R2 capacity guard refuses transfers above its 7.5 GB projected-use threshold. The broader goal remains active.

### Restore and external backup verification — 2026-11-16 follow-up

The local full dump is restored and integrity-checked in an isolated Supabase PostgreSQL 17.6 container. Its `pg_restore` catalog and decompression checks pass; required extensions are present; `pg_amcheck` passed 2,057 relations / 117,158 pages. Per-table row-count digests match all 274 public and 316 stable application-schema tables at the backup snapshot (changing `cron`/`net` logs excluded). A byte-identical reconstructed copy was downloaded from R2 and passed the same archive-read checks. R2 contains a manifest and two private dump parts (139,185,553 payload bytes total); public R2 domains are disabled. A separate table-level archive and prune receipt are stored in the same private bucket.

The dump is a full recovery backup, not a queryable cold archive. The cohort archives have tested cold restore into PostgreSQL, but R2 still has no Kairos runtime archive reader. Supabase remains writable at 847,129,747 bytes, above its 500 MB Free database quota; the 400 MB target still needs 447,129,747 bytes of actual reclamation. Any additional active history must pass a table-specific reader/parity gate before removal.

### Evidence-record archive milestone — 2026-11-16 08:44 UTC

The owner-only full backup restored locally and contained the exact live `public.evidence_records` snapshot: 77,167 rows, IDs 1–77,181, retrieved-at bounds 2026-07-02 14:02:27.42 UTC through 2026-11-12 14:01:50.793 UTC, and ordered JSON row-content digest `11914f224f4bb296a132bfaa0ea483e0`. A 2,627,533-byte gzip-compressed PostgreSQL COPY data archive was created, restored into a clean local database, and independently restored again from a downloaded R2 copy; all counts, bounds, and content digest matched. Archive, manifest, restore receipt, and immutable prune receipt each passed R2 round-trip SHA-256 checks. The R2 object uses 2.63 MB and remains private.

The source audit found no app/lib/component reads, SQL view/function reads, or FK dependencies. The only table trigger is the enabled append-only update/delete guard. Under ACCESS EXCLUSIVE lock, a database-side assertion rechecked exact count, ID bounds, and full row-content digest before `TRUNCATE TABLE ONLY`. Independent SQL then showed zero rows, 40,960 relation bytes, a 45,441,024-byte database reduction, and total DB size **934,849,683 bytes**. The guard remains enabled. The table remains cold-only: Kairos SQL queries will require restoring the archived rows to Postgres. The target and working application-read path are not yet complete.
