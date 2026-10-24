# Provider cache archive and recovery

Status: approved by owner October 24, 2026 (backup/restore/prune recommendation,
followed by "ok"). Operational local tooling only; no app routes, schema,
credentials, access rights or paid services are introduced.

Delivery status: archive/verify/local-drill tooling implemented; six unit tests
and a real PostgreSQL synthetic round trip passed. Full production export is
blocked: the first read sequence timed out, and the sole smaller-page retry
failed with HTTP 525. Both partial files lack a manifest and are NOT valid
backups. No production rows were deleted. Production prune/restore commands
are not implemented or authorized to bypass the blocked safety gates.

## Scope and invariants

Archive public.av_cache rows with cache_date strictly before a frozen UTC
today-minus-45-days cutoff, and only when a newer slot for that key exists.
Always preserve the newest slot for every key. Other tables, especially trades,
research packets, scores, labels and immutable audit ledgers, are out of scope.
Original payload and fetched_at must survive export and restoration unchanged.

## Implementation

Reuse existing service-role REST read access and installed PostgreSQL 17 tools.
The saved SUPABASE_DB_URL is currently a placeholder, so production pruning is
blocked until the owner supplies a valid private connection configuration.
Credentials pass through child process environment only, never command arguments,
output, logs or committed files. Reject a connection that does not identify the
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

Future pruning (not implemented in the local archive tool): only after verification, load small archived batches into a production TEMP
table and delete matches on the complete original four-column row, still
older than cutoff and superseded at deletion time. Changed rows are skipped.
Use bounded lock/statement timeouts and sequential batches, not a whole-cache
delete. Keep an append-only local deletion receipt. No automatic schedule.

Restoration uses these original columns and conflict-do-nothing, never overwrites
a newer/current slot, and never restamps old evidence as current. A local archive
is not an always-online data source for the cloud app.

## Physical space and failure gates

No deletion before a successful PostgreSQL restore drill. Failed authentication,
incomplete export, checksum/count mismatch, schema drift or unsafe disk headroom
stops the operation. No automatic VACUUM FULL, pg_repack, instance restart,
session termination or paid upgrade. Ordinary vacuum/reusable space is distinct
from physical quota reduction, which must be measured and reported honestly.
