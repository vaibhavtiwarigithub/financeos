# Storage budget and recoverable cold archive — proposal

Status: proposed, 2026-11-10. Owner approved the hybrid direction; exact durable-data retention and external archive access remain open. A controlled transaction removed 500 approved expired cache rows; no archive or durable-data deletion has been deployed.

## 1. User intention

Keep the FinanceOS production database below 400 MB, with warning and corrective action before the 500 MB Free-plan quota, while retaining restorable research and financial evidence at zero new paid spend.

## 2. Current architecture

Supabase Postgres is the transactional source for auth, research, price, decision, and trading records. Vercel runs the existing db-cleanup route. A local `pg_dump` script exists, but the only observed local dumps are two zero-byte July files; restore is unverified. On 2026-11-10 production database size was about 1.55 GB, `av_cache` about 580 MB. Existing safe retention candidates total about 211 MB row-data; 7-day candle-cache candidates overlap the 30-day cache candidates. Cache expiry alone cannot reach 400 MB. The November 15 Free-plan grace deadline is a separate billing risk from the 95%-disk read-only condition.

## 3. Proposed architecture

1. Keep current transactional and recent queryable data in Supabase. Do not split an active transaction across databases.
2. Use the existing cleanup job daily for explicitly disposable provider cache and already-approved safe retention windows. Report any failed step as degraded health.
3. Measure database size, table/index size, daily growth and projected days to 400/500 MB on each natural daily health cycle. Warn at 350 MB; treat 400 MB as a budget breach requiring operator action. Do not label the system healthy merely because cleanup ran.
4. Evaluate Cloudflare R2 Standard as a cold archive destination. A bounded archival process exports only selected closed, immutable historical cohorts, records a versioned manifest with market, table, time range, row count, byte count and SHA-256, then proves a sampled full restore into an isolated database. Keep an independently restorable full backup as well. Only after both proofs may the approved cohort be pruned from production.
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

The owner must approve which historical tables and horizons can leave the online database, the restore time objective, and creation of the R2 bucket/access path. Free R2 usage is limited to 10 GB-month Standard storage and operation quotas; exceeding those requires a stop or separate approval, never automatic paid spend. The project needs a verified backup and direct production recovery path before deleting durable history. A hard promise to stay below 500 MB is impossible while essential data can grow without a bounded write budget.

## 9. Acceptance criteria

Production is writable; a nonzero full backup restores into an isolated database; an archive cohort restores with exact row counts and checksums; active read paths and evaluators continue to work; actual database size falls below 400 MB; daily monitoring reports size and projected threshold crossings; natural cleanup runs succeed; no account, trading, score, or historical financial record is altered.

## 10. Approval gate

The hybrid direction is approved by the owner's “ok go” on 2026-11-10. The table-by-table durable retention policy and external storage access are not yet approved. Those specifics must be reviewed before implementation of archive deletion or a new security boundary.
