# Provider cache archive and recovery

Status: approved by owner October 24, 2026 (backup/restore/prune recommendation,
followed by "ok"). Operational local tooling only; no app routes, schema,
credentials, access rights or paid services are introduced.

Delivery status: the fresh retry exported 28,082 rows (64,528,725 compressed
bytes), verified checksums and restored every real row into local PostgreSQL 17
with the same dataset fingerprint. A complete read-only plan found all 28,082
eligible. Ten focused tests include HTTPS source restriction, real local pruning and restore behavior.
The owner-approved production prune completed: 28,082 removed in 327 batches,
zero oversized/skipped rows, all 7,677 latest-key dates preserved and zero
remaining eligible old superseded rows. Physical database size remains about
1.37 GB; quota recovery is not claimed. Earlier
partial files remain invalid backups, never authorization to delete. There is
no automatic production restore mode.

## Scope and invariants

Archive public.av_cache rows with cache_date strictly before a frozen UTC
today-minus-45-days cutoff, and only when a newer slot for that key exists.
Always preserve the newest slot for every key. Other tables, especially trades,
research packets, scores, labels and immutable audit ledgers, are out of scope.
Original payload and fetched_at must survive export and restoration unchanged.

## Implementation

Reuse existing service-role REST read access and installed PostgreSQL 17 tools.
The saved SUPABASE_DB_URL is a placeholder. The October 24 retry verified the
already-authenticated SUPABASE_ACCESS_TOKEN Management SQL path (fixed project,
no new token, credentials, grants or public RPC); use that existing path instead.
Credentials stay in process memory/environment and HTTPS authorization headers,
never command arguments, output, logs or committed files. Reject a connection that does not identify the
FinanceOS project. No authentication bypass or generic public SQL RPC.

Use an owner-only archive directory outside Git and outside OneDrive. Export
bounded sequential REST pages to gzip NDJSON, retaining a manifest with frozen predicate,
row count, compressed SHA-256, schema/column identities and creation time.
Freeze latest-date metadata before payload export. This is not a transactional
snapshot. Export JSONB as PostgreSQL text, avoiding JavaScript numeric rounding;
preserve microsecond timestamps. Later deletion must recheck each full row.
Restore to a temporary, loopback-only PostgreSQL cluster on this device with a
random local password; match counts and canonical dataset fingerprints. Stop
the local server after testing; retain archive/manifest and drill evidence.
The CLI enforces a current-account-only Windows ACL and real-path containment.
Compression is not encryption. A single-device archive is not disaster recovery.

Pruning: only after archive verification and a matching real local restore
receipt, supply at most 100 archived rows / 8 MiB original source data per SQL transaction through
a materialized JSON recordset (rather than a persistent or TEMP staging table).
The API request stays under 512 KiB by carrying the full payload's SHA-256 rather
than resending bulk JSON. Match exact original key/date/fetched_at plus PostgreSQL
SHA-256 of the complete payload text (the same byte representation verified in
the restore drill). This replaces literal payload equality with cryptographic
integrity matching, not a timestamp-only shortcut. Delete matching rows, still
older than cutoff and superseded at deletion time. Changed rows are skipped.
Lock the latest retained row per key FOR KEY SHARE for the short transaction;
keep it out of the delete set. Use 500ms lock / 10s statement timeouts,
sequential batches, append-only durable local intents/results, and no automatic
retry after an uncertain response. Oversized rows are retained. Preflight refuses
custom triggers, rules or related foreign keys; no other table may be affected.
The read-only prune plan must finish first. No automatic schedule.
Management requests are paced to at most 60/min (published limit 120/min), with
proactive X-RateLimit-Remaining/Reset headroom. HTTP401/403/429 are recorded as
rejected, never silently retried. Other ambiguous outcomes stop and prevent
restart without reconciliation. Completed read-only plan batches may be reused
only for their exact archived-row hash; every real deletion rechecks all three
scalar columns and the full payload digest. Before/after latest-slot inventories must not regress.

Future deliberate production restoration must use original columns and conflict-do-nothing, never overwrite
a newer/current slot, and never restamps old evidence as current. A local archive
is not an always-online data source for the cloud app.

## Physical space and failure gates

No deletion before a successful PostgreSQL restore drill. Failed authentication,
incomplete export, checksum/count mismatch, schema drift or unsafe disk headroom
stops the operation. No automatic VACUUM FULL, pg_repack, instance restart,
session termination or paid upgrade. Ordinary vacuum/reusable space is distinct
from physical quota reduction, which must be measured and reported honestly.
