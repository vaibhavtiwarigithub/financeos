# Storage budget and recoverable cold archive — proposal

Status: cache-only R2 backup path approved by owner on 2026-11-10; durable-data retention and production pruning remain unapproved. The owner separately authorized clearing all disposable `av_cache` responses for disk recovery on November 10. No external archive or durable-data deletion has been verified.

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
- Backup unavailable or zero bytes: block durable-data deletion.
- A cohort still used by live evaluators, active backtests, or financial reconciliation: keep queryable source rows.
- Cache cleanup succeeds but database remains over 400/500 MB: report the measured breach, never infer compliance from deleted-row counts.
- Daily growth exceeds available headroom between checks: alert on projected breach; a schedule cannot guarantee a hard ceiling without ingestion budgets or a fail-closed admission policy for nonessential data.

## 7. Files that may be touched later

`app/api/agents/db-cleanup/route.ts`, existing System Health read paths, `scripts/backup-db.ps1`, a bounded archive/restore script, relevant `docs/arch/` chapters, `WORK_LOG.md`, and `public/agent-diagrams/system-map.json` if data flows change. Any new schema or access boundary requires its own migration and review.

## 8. Risks / decisions needed

The owner approved the R2 backup direction on 2026-11-10. Cloudflare CLI authentication and a private bucket remain operational prerequisites; no token is copied into the repository. The owner must still approve which durable historical tables and horizons can leave the online database and the restore time objective. Free R2 usage is limited to 10 GB-month Standard storage and operation quotas; exceeding those requires a stop or separate approval, never automatic paid spend. The project needs a verified full database backup and direct production recovery path before deleting durable history. A hard promise to stay below 500 MB is impossible while essential data can grow without a bounded write budget.

## 9. Acceptance criteria

Production is writable; a nonzero full backup restores into an isolated database; an archive cohort restores with exact row counts and checksums; active read paths and evaluators continue to work; actual database size falls below 400 MB; daily monitoring reports size and projected threshold crossings; natural cleanup runs succeed; no account, trading, score, or historical financial record is altered.

## 9a. Cache-only R2 transfer implementation, November 10

`scripts/r2-cache-archive.mjs` accepts the existing owner-protected provider-cache archive directory and a private R2 bucket. It re-verifies the manifest and local PostgreSQL restore receipt, requires a measured `KAIROS_R2_VERIFIED_FREE_HEADROOM_BYTES` greater than the complete upload size, uses Wrangler's explicit `--remote` setting, downloads every object, verifies hashes and row count, and writes a local receipt only after the round trip succeeds. It has no database write or R2 delete command. Its 13 focused archive tests pass. Wrangler OAuth completed on November 10, but `r2 bucket list` returned Cloudflare code 10042 (`NotEntitled`): this account has no R2 subscription. Cloudflare requires an account checkout before R2 use, with billing beyond the included free monthly allowance. Under the owner's no-paid-services constraint, R2 enrollment and production upload remain blocked pending an owner account decision. The existing local archive remains intact. This cache-only backup is not a full database backup and cannot authorize durable-data pruning.

## 9b. Emergency disposable-cache recovery, November 10

After the owner explicitly authorized clearing fresh as well as expired raw provider responses, a single `BEGIN READ WRITE` transaction truncated only `public.av_cache` with a five-second lock timeout and no cascade. Immediately before the operation, the table had 58,994 rows, occupied 608,018,432 bytes, and had no inbound foreign keys or custom triggers. Verification afterward showed zero rows, a 24,576-byte table, and database size reduced from 1,646,013,587 to 1,038,019,731 bytes. At 2026-11-11 03:48 UTC a new session reported both `default_transaction_read_only` and `transaction_read_only` off, with database size 1,038,027,923 bytes. Natural scheduled write persistence and the billing-period quota still require separate verification. The existing local archive covers an older subset only; fresh cache will be refetched subject to provider budgets. No durable research, score, label, position, order, or trade table was changed. This does not achieve the 400 MB target or necessarily clear the billing-period average quota.

The existing `scripts/backup-db.ps1` passed a password-bearing URI to `pg_dump` on the command line and wrote dumps under the OneDrive workspace. It now passes the password only through libpq's child environment, validates the FinanceOS target, stores dumps in an explicit current-user-only local directory, verifies archive structure, and avoids automatic deletion of earlier backups. Three focused tests, the 4,790-test app suite, TypeScript, and changed-file secret scan passed. The fix is on main `2297dbbd1750a0b8f3ebf354a5a5539cfc6262b5`, and Vercel production deployment `dpl_84BdSpKiS6WgY3kk9xvF4ADhFEzW` was READY; `/login` returned HTTP 200. The owner's claimed `SUPABASE_DB_URL` update is not yet visible in the exact ignored `.env.local` file: its one matching line still contains `[YOUR-PASSWORD]`, so no full dump or full restore proof exists. The backup script fails closed without printing the value. The natural 2026-11-11 04:00 UTC `kairos-watchdog` tick produced a newer `evolution_supervisor` row, status `done`, state `attention`, no read failures. Its queue increased from 14 to 20 after the outage, including missed Nov 10 label, benchmark, and US evidence runs and a critical US price-cache freshness breach. No route was manually invoked, and those missed producers and freshness conditions are not marked resolved.

## 10. Approval gate

The hybrid direction and a private R2 backup test for the existing verified provider-cache archive are approved by the owner's “ok go” and “plan and fix ... and also cloudfare backup” on 2026-11-10. Durable table retention and production archive deletion are not approved. A new credential or public bucket access boundary remains disallowed without its separate owner action.

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
