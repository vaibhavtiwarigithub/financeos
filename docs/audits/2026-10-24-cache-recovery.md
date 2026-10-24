# Local provider-cache recovery: verified tooling, blocked production archive

Owner approved backup-before-prune on October 24. Free plan remains unchanged.

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

## Production result: NOT a verified backup

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

## Remaining gates and next safe action

1. Wait for healthy source reads; run a new bounded export in a new protected
   directory. Do not reuse partial output or treat the synthetic test as a real
   backup. Verify the manifest, then run `drill` against that same complete export.
2. Existing `SUPABASE_DB_URL` is a placeholder, not a working SQL connection.
   Owner must put a valid connection string privately in `.env.local`; never
   paste its password into a chat. Do not reset credentials or create public SQL
   access to work around this. Existing older zero-byte dumps are not backups.
3. Implement and test atomic, small-batch deletion with exact original-column
   matching, a still-newer slot, cutoff checks, bounded SQL timeouts and a receipt.
   Do not substitute loosely filtered REST deletes. This tool intentionally has
   no production delete/restore mode while those prerequisites remain missing.
4. Measure space separately. Deletion does not necessarily shrink physical disk
   allocation; no VACUUM FULL, repack, restart, paid upgrade or history purge was run.

A laptop backup is recovery material, not an online dependency for Vercel. An
offline/lost device cannot serve the app. Retain important live research, labels,
trades, scores and ledgers in production; independently protect any eventual full
backup before treating it as disaster recovery.
