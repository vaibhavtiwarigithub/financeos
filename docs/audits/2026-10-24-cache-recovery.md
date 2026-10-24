# Local provider-cache recovery: verified archive and guarded pruning

Owner approved backup-before-prune on October 24. Free plan remains unchanged.

## Fresh retry: real backup and restoration verified

After the owner said "do it", a new bounded export completed in
`20261024T145128Z`: 28,082 superseded cache rows, cutoff September 9, 2026,
64,528,725 compressed bytes. Compressed and canonical dataset SHA-256 checks pass.
Every row was restored into installed local PostgreSQL 17 and matched the exact
dataset fingerprint, including payload text and microsecond fetch timestamps.
The test server was stopped and its temporary password removed.

Dataset SHA-256:
`1394fb6631eef61282ee64fb423ee84135189f68e3e92340dc328c4f67de78a9`.

The existing authenticated Management SQL credential works for this project;
the placeholder DB URL does not require a new password or credential reset.
No new access, public RPC, schema object or paid resource was created. Preflight
confirmed zero cache custom triggers, related foreign keys and custom rules.

The first read-only planning attempt hit HTTP429. No deletion had occurred.
Planning was repaired to respect Supabase's published 120 requests/minute limit:
at most 60/min, with proactive response-header headroom. Bulky payload uploads
were replaced by their full SHA-256; exact key/date/fetched_at checks remain.
Transactions cap 100 rows, 8 MiB archived source, 512 KiB request, 500ms lock wait
and 10s statement time. Oversized entries remain untouched. Completed read-only
batches are reusable only for the identical archived-row fingerprint.

The complete plan inspected 28,082 and matched 28,082, with zero oversized rows,
in 327 requests. Earlier progress counts included a buffered lookahead row;
the final count showed no rejected row. Progress reporting now counts completed
rows instead.

## Completed production prune and measured storage

At 15:18:56 UTC, all 28,082 archived rows were pruned in 327 committed bounded
batches; zero oversized or unmatched rows. The protected local result is
`prune-result-1792855136284.json`. `prune-events.ndjson` holds durable per-batch
intents and returned key/date receipts. No financial, score, research, label or
audit table was targeted; cache triggers/rules/foreign keys were absent.

`retained-key-verification-1792855136281.json` confirms 7,677 keys before and
7,677 after, with zero missing or regressed latest dates. The operation lock and
local test password are absent; local test servers are stopped.

At 15:19:07 UTC, production independently reported:

- 39,612 cache rows and 7,677 distinct keys.
- Zero superseded rows before September 9, 2026 remaining.
- 303,581,252 bytes of live payload data.
- 605,061,120 bytes allocated to cache including indexes/TOAST.
- 1,373,555,859 bytes for the whole database (about 1.37 GB decimal).

The initial whole-database measurement was 1,372,499,091 bytes, so **physical
storage did not shrink**. Other app writes and allocated reusable pages remain;
do not present removed-row counts as MB reclaimed or claim the storage quota
incident resolved. Autovacuum ran at 15:18:32 UTC; later stats estimated 2,265
dead cache tuples still awaiting subsequent routine maintenance. No duplicate
manual vacuum, blocking FULL rewrite/repack, restart or paid upgrade was run.

The remaining issue is physical quota/headroom, not a failed archive or prune.
Standard vacuum normally makes pages reusable rather than returning all space
to the operating system. A blocking rewrite would require a separately assessed
maintenance/headroom plan; it is not safe to silently run it on the overloaded
Free instance. Relevant primary explanations:
https://supabase.com/docs/guides/platform/database-size
https://www.postgresql.org/docs/17/routine-vacuuming.html#VACUUM-FOR-SPACE-RECOVERY

Each delete protects the latest row with FOR KEY SHARE and rechecks the full
payload SHA-256 plus the exact original key/date/fetch timestamp. Uncertain or
unfinished mutations block further execution. Durable local intents/results and
an exclusive operation lock prevent blind retries or overlapping pruning.
Ten focused tests passed, including exact HTTPS project restriction, local PostgreSQL changed-payload/timestamp,
latest-only, repeated-prune, hostile-looking key text and precise restore cases.
TypeScript and secret scanning passed; no runtime app or financial-policy change.

Primary reference for rate limits:
https://supabase.com/docs/reference/api/introduction#rate-limits

## Implemented and tested

- Only `public.av_cache`, strictly older than a frozen UTC 45-day cutoff and
  superseded according to latest-date metadata. Latest slots and all other
  tables are excluded. REST export is not a transactional snapshot.
- Sequential, keyset-paged reads using existing service credentials in memory.
  JSONB is fetched as text; large integers are never parsed as JS numbers.
  Timestamp fingerprints retain six-digit microseconds.
- Gzip JSONL archive, row-count and dataset/compressed SHA-256 verification.
  CLI rejects wrong project/contract, duplicates, corruption and cutoff violations.
- Outside-repository/outside-OneDrive storage with enforced account-only ACL.
  Gzip is not encryption. No credentials are embedded in an archive.
- Installed PostgreSQL 17 local-only cluster, random temporary password,
  loopback-only port 55439, streaming COPY and fingerprinted restored results.
  A synthetic two-row test passed, including Unicode, quotes/newlines, a number
  greater than JS's safe-integer range and microsecond timestamps. The server
  stopped and temporary password was removed. No production model calls or trades.
- Six pure/integrity tests passed; opt-in integration test passed independently.
  TypeScript passed. No schema migration or runtime application change.

## Earlier failed exports: NOT verified backups

First export stopped after reporting 2,000 rows with a request timeout. Its
partial compressed file is 13,874,606 bytes. One smaller-page retry failed with
HTTP 525; its partial file is 2,728,766 bytes. Neither has a completion manifest;
neither was restored or used to authorize deletion. No retry loop was started.

Directories under the owner-only local backup root:

- `20261024T140149Z`: incomplete first production export.
- `20261024T140328Z`: incomplete production retry.
- `synthetic-qOBt05`: successful synthetic PostgreSQL round-trip receipt.

Root: `C:\Users\vaibh\AppData\Local\Kairos\backups\provider-cache`.
The older `synthetic-FW0Jro` fixture was retained stopped after discovering and
fixing Windows pg_ctl inherited-pipe handling; its temporary password was removed.

## Earlier blockers and their resolution

1. Source reads recovered, and the new complete export passed its real restore
   drill. The partial files and older zero-byte dumps are still not backups.
2. The placeholder `SUPABASE_DB_URL` is not used. Reuse of the existing authenticated
   Management SQL path was verified instead; no owner password action is needed.
3. The bounded prune path and local PostgreSQL regressions are implemented. Never
   substitute loosely filtered REST deletes or alter the archive to skip a guard.
   Production restoration is a separate deliberate import, not an automatic mode.
4. Physical size was measured separately and did not shrink. Deletion does not necessarily shrink physical disk
   allocation; no VACUUM FULL, repack, restart, paid upgrade or history purge was run.

A laptop backup is recovery material, not an online dependency for Vercel. An
offline/lost device cannot serve the app. Retain important live research, labels,
trades, scores and ledgers in production; independently protect any eventual full
backup before treating it as disaster recovery.
