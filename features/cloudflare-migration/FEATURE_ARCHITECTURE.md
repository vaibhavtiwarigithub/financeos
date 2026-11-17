# Kairos full Cloudflare migration and write-continuity plan

**Status:** Owner approved staged implementation on 2026-11-17 (“go with full fix”). Production cutover and source-data removal remain gated on the verification criteria below. Owner direction: Kairos should run entirely on Cloudflare and regain app write capability before the Supabase restriction is expected to lift on December 8, 2026. **Cost constraint:** remain on free plans; never incur automatic overages or silently move to a paid plan.

## Decision record

- **Why:** Supabase Fair Use has restricted project APIs after organization database-size usage exceeded its quota, and Kairos must remain usable before the next quota reset.
- **Who:** Vaibhav, the single Kairos owner and operator.
- **ROI:** restore reliable owner access and reduce dependence on a provider whose database quota has already stopped app API requests, while retaining existing financial and research history.
- **shippedAt:** not shipped; this is an architecture plan.

## Recommendation

Proceed toward a full Cloudflare target, but stage it. Cloudflare is the intended authoritative database platform: D1 for relational hot data and private R2 for verified cold archives. Render and Vercel may remain app runtimes during migration, but both must call the same private Cloudflare database gateway and neither is a data authority. Hyperdrive is only an optional temporary bridge to Supabase PostgreSQL; it is not the target database and is not a prerequisite for the D1 migration.

The final target is a Cloudflare Workers application, D1 for relational hot/operational data, private R2 for immutable historical archives and large objects, Cloudflare Access for owner authentication, and Cloudflare Workflows/Cron for background jobs. Do not attempt to transplant Supabase into D1 wholesale. The 2026-11-17 database inventory measured 274 public tables, 439 applied Supabase migrations, approximately 433,273 estimated rows, and 1,877 `.from(...)` calls against 246 statically named tables across app code. There are also RPC, RLS, trigger, `pg_cron`, and vector-backed memory dependencies. The migration must replace these contracts incrementally and prove behavior before each data domain changes authority. See [database inventory](DATABASE_INVENTORY.md).

## Current evidence and hard constraints

- Supabase emailed that API requests are restricted until the December 8, 2026 quota reset. Auth and PostgREST requests were observed returning HTTP 402 `exceed_db_size_quota`.
- The email reports 1.29 GB / 1.1 GB for the billing-cycle database quota metric; the latest direct Postgres size query separately measured about 829 MB. These are different metrics. Supabase's current database-size documentation says Fair Use database-size restrictions are based on the organization's **average daily database size during the billing period**, so reducing the live database does not immediately clear the restriction. [Supabase database size and Fair Use](https://supabase.com/docs/guides/platform/database-size)
- The PRD identifies Kairos as a Next.js 15 App Router application, currently using Supabase Auth and database access. It is a dynamic app with server components, route handlers, and server-side jobs; static Pages export is not a target.
- The existing platform review documents 27 configured Vercel cron routes and a local Claude CLI integration that is unavailable on hosted Vercel today.
- The Nov 16 production Postgres dump is 132.74 MiB in custom compressed format. Its isolated local restore is 973,076,147 bytes with 1,583,520 rows across 270/274 public tables; restore errors remain for Supabase-only extensions and six policy/trigger/function differences. It is useful for staging experiments but is not yet a complete migration source of truth. See [database inventory](DATABASE_INVENTORY.md).
- D1 accepts SQLite-compatible SQL imports; it does not import PostgreSQL syntax directly. Official docs cap each import file at 5 GiB and require translating PostgreSQL schema/types/SQL to SQLite. Free D1 still caps each database at 500 MB, the account at 5 GB, and writes at 100,000 rows/day; imported rows cannot be assumed to bypass those quotas. The 973 MB restored Postgres footprint therefore needs measured SQLite sizing and explicit domain partitioning before any bulk import. [Import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- D1 Free currently allows 10 databases, 500 MB per database, 5 GB aggregate, 100,000 rows written/day, and 5 million rows read/day. A database over 500 MB must be partitioned or reduced; multiple D1 databases do not provide cross-database foreign keys or transactions. D1 databases are single-threaded. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- R2 Standard currently includes 10 GB-month storage and free egress. Kairos's safety target remains a hard operational stop at 8,000,000,000 bytes; Cloudflare does not enforce this app-specific cap for all credentials. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- Workers Free currently allows 100,000 requests/day, 10 ms CPU per request and per Cron Trigger, and five Cron Triggers/account. Workflows are available on Free, but each invocation still has the 10 ms CPU limit; current free allocation is 3,000 steps/day and 1 GB-month Workflow storage. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)
- Cloudflare recommends vinext for full-stack Next.js on Workers, but vinext is in beta and its compatibility page calls for running a compatibility check and reviewing unsupported/partial features. [Cloudflare Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
- Cloudflare's current Workers pricing lists Vectorize as Paid-only. Kairos currently has pgvector-backed memory features, so semantic retrieval cannot be promised under an always-free requirement without either a verified free alternative or an explicit feature change. [Workers pricing: Vectorize](https://developers.cloudflare.com/workers/platform/pricing/)

## Scope

### In scope

- Restore authenticated, owner-only app data writes before December 8 through a Cloudflare-owned data path.
- Move the full-stack web runtime, authentication boundary, relational data, scheduled/background execution, and archive access to Cloudflare.
- Preserve existing data with verified backup/restore and record-level parity checks.
- Keep all Cloudflare resource use within Free limits with explicit stop thresholds and no paid-plan fallthrough.
- Keep Render and Vercel as app-hosting options during validation; configure both to use the same Cloudflare authority. Remove Supabase and other runtime dependencies only after the cutover gates pass.

### Out of scope

- Changing trading strategies, scores, positions, broker connections, or execution settings as part of the infrastructure migration.
- Enabling any new automated or live trading action.
- Deleting Supabase source data before independent archive and D1 parity proof.
- Any paid Cloudflare plan, automatic overage, or claim that a partial D1 archive is already available to Kairos readers.

## Target architecture

```text
Browser
  └── Cloudflare Access (owner identity, validated JWT)
       └── Cloudflare Worker app (vinext after compatibility gate)
            ├── D1: hot operational and relational data, partitioned by bounded domain
            ├── R2: immutable compressed cold partitions, manifests, and restore receipts
            ├── Workflows/Cron: durable background tasks, bounded to Free quotas
            └── external market / LLM / broker APIs as existing integrations require
```

Access identity must be validated at the Worker. Do not trust an arbitrary email header. The Worker maps the verified owner identity to a stable Kairos user ID. All privileged writes remain server-side. D1/R2 access is private; no public bucket or browser-held database credential.

Suggested D1 layout is two or more bounded domains only if required by the measured table sizes: (1) owner, auth mapping, portfolio state and small operational records; (2) research/evaluation hot data. Every database must stay below 400 MB as a warning target and 450 MB as a hard stop, and the account below 4 GB warning / 5 GB absolute Free ceiling. Partitioning introduces app-side joins and cross-database consistency work; prefer one D1 database if verified cold archiving brings it safely below 400 MB. Do not split tables just to evade capacity without an explicit domain boundary.

R2 stores historical records that have a defined archive contract. Each archive object is immutable, content-addressed, checksummed, versioned, cataloged, and verified by read-back. A source cohort remains in the source database until the manifest, row count, ordered digest, reader/restore path, and rollback receipt all match. R2 is not queried with SQL and cannot participate in D1 transactions.

## Optional fallback — temporary PostgreSQL continuity bridge

### Implementation checkpoint — 2026-11-17

- Added pinned local vinext/Cloudflare Vite tooling while leaving the standard Next.js scripts and entrypoint intact. `npx vinext check` recognized 324 route handlers and 56 pages (reported 97% compatibility); the existing custom webpack hook is not supported by vinext and is ignored there.
- `npm run build:vinext` completed with vinext's Workers Cache response-stage adapter. A deployment dry run initially rejected the app because ISR had no cache adapter; the documented adapter/config was then added and the dry-run check passed without building or deploying. The generated cacheability manifest is currently `null`, so this is not evidence that protected responses are excluded from shared cache; keep every authenticated route a deployment blocker until actual cacheability probes prove it.
- The supported local production preview is `vinext start`; generic `vite preview` returned 404 for app routes. With placeholder public Supabase configuration only, `vinext start` served `/login` with HTTP 200, redirected unauthenticated `/dashboard` with HTTP 307, and returned HTTP 401 from the real protected `/api/agents/health-triage` route. Vite development still returned 404 for app routes and needs investigation before considering the runtime validated.
- Deployed private `kairos-db-gateway` Worker at `https://kairos-db-gateway.kairos-history-archive.workers.dev` and created isolated US-jurisdiction D1 staging database `kairos-app-staging`. Only `user_watchlist` schema and migration ledger are present; zero owner rows were imported.
- `app/api/user-watchlist` now routes list/add/remove through the gateway. Session identity still comes from Supabase Auth, and list enrichment still reads Supabase `agent_signals`; this is a mixed-provider staging slice, not a full Cloudflare authority cutover.
- Worker anonymous access returned 401; authenticated staging GET/POST/GET/DELETE round-trip passed for a synthetic user, and the test row was removed. Local Wrangler E2E passed. Gateway unit/integration tests passed (13 total); `npx tsc --noEmit`, `git diff --check`, and `npm run build:vinext` passed.
- Render service `kairos-free-beta` is live on commit `672817df`; its build completed and `/login` returns HTTP 200, while direct unauthenticated `/dashboard` returns HTTP 307 to login. The Access proxy returns HTTP 302 to its OTP flow for anonymous `/login`. This verifies deployment and edge gating only; owner OTP, authenticated pass-through, and dashboard data reads have not been verified. The live app remains Supabase-dependent for most data.
- Vercel env creation was rejected with HTTP 402 `resource_creation_blocked` (team Fair Use limit); local Vercel CLI is logged out. Vercel has not been configured or verified against the gateway.
- vinext remains a local probe only. Its cacheability manifest is `null`; protected-response cache exclusion is unproven, so do not deploy the app there. Render/Vercel can remain bridge hosts while Cloudflare DB migration proceeds.
- Next: finish an extension-complete, digest-reconciled restore; measure SQLite conversion sizes against D1 constraints; then port bounded application domains with their readers/writers and tests. Do not claim full Kairos or full Cloudflare authority until auth, data, jobs, archives, parity, quotas, restore, and rollback gates pass.

**Contingency only:** the following Hyperdrive notes describe an optional temporary bridge. They do not define the official database target or authorize bypassing Supabase restrictions.

1. From a controlled Cloudflare Worker, establish a direct PostgreSQL connection to the existing Supabase database through Hyperdrive. Cloudflare documents Supabase as a supported Postgres provider and recommends native `pg`/Postgres.js drivers through Hyperdrive. Hyperdrive Free has a separate ceiling of 100,000 database statements/day, including SELECTs and writes. [Cloudflare Hyperdrive + Supabase](https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/) · [Hyperdrive Free quota](https://developers.cloudflare.com/workers/platform/pricing/)
2. Prove that a direct TCP connection is allowed while the organization's Fair Use API restriction is active. The official 402 documentation confirms project API restrictions and dashboard data access, but does **not** guarantee that direct database writes bypass the restriction. Do not infer this from the still-functioning dashboard SQL/MCP connection. [Supabase HTTP 402 status](https://supabase.com/kb/troubleshooting/http-status-codes)
3. If direct connection works, use a dedicated least-privilege Postgres role, never the database owner or a service-role secret. Start read-only, then prove a transaction-scoped test write and rollback. Do not expose the connection string or role password in code, logs, chat, or browser bundles.
4. Replace Supabase Auth for the temporary owner gate with Cloudflare Access, or another verified Cloudflare-only owner authentication flow. Validate Access JWT signature, issuer, audience, and owner identity on every server request. Map the identity to the existing stable owner UUID. Preserve RLS by transaction-local claim context only if an isolated security test proves the existing `auth.uid()` policies still evaluate correctly over Hyperdrive pooling; otherwise add explicit owner-scoped SQL predicates and narrow DB grants. Never run the application as a blanket RLS-bypassing role.
5. Build a small adapter for the first explicitly selected app write flows. Start with low-risk owner data (for example, journal/watchlist/preferences) only after route inventory identifies exact tables and invariants. Keep trading, broker, strategy, score, and position writes disabled until their separate end-to-end parity/security review.
6. Deploy the continuity surface privately and test a real write/read/update/delete or safe test record end to end, then verify database audit state and owner isolation. Keep the standard Vercel/Render app surfaces unchanged until the Cloudflare app proves the same login and required screens.

This is a fallback only if the owner explicitly chooses a temporary PostgreSQL bridge. It is not a prerequisite for the approved D1/R2 migration. Any bridge must still stop if direct access is blocked, least-privilege and owner isolation cannot be proven, or the free statement allowance is insufficient. The current implementation is the D1 staging gateway slice above.

## Phase 1 — codebase and data inventory

- Run the Cloudflare vinext compatibility check on the exact repository commit and classify every reported incompatibility; test a Worker build without changing the production app entrypoint.
- Build a generated inventory of table access, RPC usage, client/browser queries, Auth/storage/realtime, SQL functions/triggers, migration history, extensions, foreign keys, row-level policies, pg_cron jobs, scheduled Vercel routes, and external secrets/integrations.
- Classify each table as hot operational, hot research, bounded cache, append-only evidence, vector memory, or cold archive. Document all consumers and keys before assigning a new D1 database.
- Restore the custom dump to isolated PostgreSQL 17. Record `pg_restore --list`, migration/schema inventory, per-table row counts, important ordered digests, sequence/identity state, and full database size. Verify all archive files independently.
- Produce an exact Cloudflare Free usage model from real job/API traces: Worker requests and CPU percentiles, D1 rows read/written including indexes, Hyperdrive statements for the bridge, Workflow steps/CPU/state, R2 bytes/operations, and Vectorize alternatives. No spreadsheet estimate may substitute for observed traces.

## Phase 2 — Cloudflare app and identity proof

- Create an isolated Cloudflare Worker project/preview; do not replace Vercel/Render deployment.
- Use vinext only if the check passes for Kairos routes and actual build/preview proves server components, middleware, route handlers, cookies, streaming behavior, API body sizes, caching, and error handling.
- Add Access protection and server-side identity verification. Cover login, logout, stale/expired session, unauthorized API, and identity spoofing.
- Exercise representative pages and API routes against the continuity adapter. Required proof: browser login, protected dashboard reads, a safe owner write persists and reappears, and no client can directly reach D1/R2/Hyperdrive.
- If the Next/vinext route fails, evaluate a focused React SPA + Workers API only as a separate product-surface reduction; do not silently drop server routes or dashboard behavior.

## Phase 3 — D1 schema and data ports

- Convert domain groups from PostgreSQL to SQLite with explicit reviewed migration files. Inventory and replace unsupported Postgres features: RPCs/functions, triggers, policies, extensions, vector operators, JSON/array/date casts, `ON CONFLICT` behavior, transaction assumptions, UUID generation, numeric precision, and server-side auth.
- Preserve financial quantities using integer minor units or exact decimal-text contracts; do not round through JavaScript floating point.
- Use explicit repositories/domain services; do not try to emulate arbitrary Supabase query-builder behavior globally. Port by vertical slice and keep endpoint contracts stable.
- Keep current `symbol_daily_returns` archive work as an isolated verified cohort; do not treat it as the D1 application schema. It is currently 99,000 / 261,678, `loading`, with reads disabled.
- Import each D1 slice only after checking the day's remaining 100,000 row-write quota. DDL/index writes count. The daily-return archive has two secondary indexes; its import planner now defaults to 20,000 source rows/day (about 60,000 estimated row writes, reserving 40,000 account-wide for live app traffic and overhead). Recheck actual quota and query `meta.rows_written` on each UTC day before starting a chunk. Use idempotent chunks, stable keys, counts/digests, and isolated restore. Never delete source rows to make the quota look better.
- Archive only explicit cold cohorts to R2. Build typed readers for every online historical read and a bounded staging/rehydration workflow for relational analytics. Fail visibly on archive miss or digest mismatch.
- For semantic memory, test whether an always-free approved feature path exists. Current official Workers pricing marks Vectorize Paid-only. Proposed free fallback is D1 FTS5 lexical retrieval with archived embeddings retained in R2, but that is a feature-quality change and must be measured and owner-approved before replacing pgvector behavior.

## Phase 4 — background jobs and external integrations

- Map every current Vercel cron and `pg_cron` schedule to one of at most five Free Cron Triggers, with Workflows for idempotent multi-step tasks. Consolidation must preserve timezone, market calendar, retry, backoff, concurrency, and dedupe semantics.
- Check the Workflows Free allocation of 3,000 steps/day, 10 ms CPU/step, 1 GB-month state, and three-day state/log retention. Jobs whose measured CPU, daily step count, or required retention exceed Free are out of scope until redesigned or explicitly dropped; do not enable paid billing.
- Keep long provider/LLM calls in network-waiting Workflow steps and persist checkpoints, but bound payloads, retries, and provider spend. External API keys are runtime secrets only.
- Keep the local Claude CLI/Robinhood MCP bridge explicitly laptop-only unless a separately authorized and secure Cloudflare-compatible integration is designed. Do not move broker secrets or enable automated orders as part of this migration.

## Phase 5 — parallel parity and cutover

- Dual-write only through an idempotent transactional outbox or a source-of-truth change log; raw best-effort dual writes are not acceptable. Reconcile source and destination row counts, primary keys, foreign-key equivalents, ordered digests, and domain invariants continuously.
- Run Cloudflare in shadow-read mode first. Compare route outputs and stored-write results against the current app without changing scores, trading decisions, positions, strategies, or broker behavior.
- Cutover requires: complete verified database restore; all required tables and migrations present; all critical read/write contracts tested; auth isolation passes; all required scheduled jobs fit observed Free quotas; D1 below its hard per-database/account limits; R2 inventory below 8 GB; no paid product dependency; rollback tested; and no unresolved parity differences.
- During cutover, pause producers, finish/reconcile the outbox, take a final source snapshot, validate destination digests, then switch the Cloudflare app's authoritative data binding. Keep Vercel/Render and source backups available through a defined rollback period. Never delete Supabase data during the rollback period.
- After owner verification of the Cloudflare app, disable writes on the old path, retain a verified final export, and only then remove Render/Vercel/Supabase runtime dependencies. Removing accounts/resources is a separate reviewed action.

## Always-free acceptance gates

1. No monthly or per-invocation paid product required. Configure billing/spending limits where supported; fail closed at the free quota rather than incur charges.
2. Worker p95 and worst-case CPU stay safely below 10 ms for all required interactive/API/Cron paths; daily requests remain under 100,000.
3. No more than five Cron Triggers/account; Workflow work stays inside the measured Free step/CPU/storage/subrequest allowances.
4. Each D1 DB remains below 450 MB hard stop (400 MB warning), and aggregate D1 below 5 GB with at least 20% headroom; daily reads/writes remain below quotas with reserved headroom.
5. R2 account use remains below 8,000,000,000 bytes, using conservative object metadata accounting and complete paginated inventory before/after writes.
6. Any feature unavailable for free, notably Vectorize per the current pricing page, is either replaced with verified equivalent behavior or explicitly excluded from the accepted parity set.
7. All checks are automated, read-only where possible, and produce owner-visible status; no automatic deletion or paid fallback.

## Implementation decisions inferred from owner approval

- The continuity path must preserve the existing app's authenticated read/write behavior as broadly as the direct-Postgres proof allows; do not silently label a reduced feature slice “full Kairos.”
- Keep the always-free constraint. Do not adopt Paid-only Vectorize. All four current vector tables are empty (read-only production count, 2026-11-17), so their current retrieval result is empty; preserve that behavior during cutover and port storage/query contracts only if a measured free implementation can pass parity and CPU tests. A future need to ingest/search vectors at scale is a release gate, not permission to incur a charge or silently replace semantics.
- Preserve application route contracts and trading-related data semantics, but do not initiate or alter broker, order, position, score, strategy, or execution behavior as part of the migration.
- The owner approved implementation of the architecture and phased rollout. This does not authorize skipping security, backup/restore, parity, quota, or rollback gates; it does authorize the required code and preview-resource work behind those gates. No production cutover or destructive source deletion occurs until those gates pass.

## Access deployment checkpoint — 2026-11-17

- Created Cloudflare Zero Trust organization `Kairos FinanceOS` on the free Access path and One-time PIN provider `Kairos owner email OTP`. Added self-hosted app `Kairos App (Render)` at `kairos-app-proxy.kairos-history-archive.workers.dev`, with one allow policy for `vterminater@gmail.com` and a 12-hour session.
- Cloudflare's script-search API returned the Worker's internal identifier. The Access app binds its public hostname and that exact Worker destination. The audience is stored in the Wrangler config and Worker version `80be9005-3018-42d6-8281-7a79ec610bdd` is deployed. An unauthenticated `/login` request returned HTTP 302 to the Access login flow, verifying edge enforcement. Owner OTP and authenticated pass-through have not yet been exercised.
- The app auth bridge validates the forwarded Access JWT signature, issuer, audience, expiry, and exact owner email. Render still needs the non-secret Access environment settings and deployment of this source revision. Its current live commit is `69b5cac...`; its protected proxy must not be described as a fully working Kairos app until OTP sign-in and an authenticated dashboard request succeed.
- Render now runs commit `672817df` with the non-secret Access identity settings. `/login` returned HTTP 200, direct unauthenticated `/dashboard` returned HTTP 307, and the public Access proxy redirects anonymous `/login` with HTTP 302. These are deployment/unauthenticated-routing checks only; no owner OTP or authenticated dashboard session has been verified.
- Vercel variable creation previously returned HTTP 402 `resource_creation_blocked` from Fair Use. No Vercel Access/gateway deployment is verified.
- The gateway is only the watchlist route slice. Most page/API readers still call Supabase, and watchlist score enrichment still reads Supabase `agent_signals`; thus Cloudflare is not yet the app's complete data authority.
- A loopback-only PostgreSQL 17 restore attempt of the Nov 16 custom dump currently has 270/274 public tables and exactly 1,583,520 rows restored; its size is 973,076,147 bytes. Four vector-typed tables could not be restored without the pgvector extension (`agent_memory`, `doc_chunks`, `trade_decision_embeddings`, `trade_memories`), and Supabase-only extension objects/policies also caused restore errors. The source backup is therefore partially inspected, not yet a full verified restore. Prior live checks found the vector tables empty; a final transfer still requires an extension-complete restore or independently verified source counts/digests.
- The first Render build of commit `71831811` stopped at `npm ci` because the committed lock omitted optional `@emnapi` dependencies. The initial Linux regeneration with npm 11.6 did not satisfy Render's Node 24.22.1/npm 11.19.1 toolchain. Regenerated under that exact Node/npm version; its Linux `npm ci --dry-run --include=optional --no-audit` passes and includes `@emnapi/runtime@1.11.3`. Redeploy still must confirm Render's own build and app stage.
- Render's Node 24.22.1/npm 11.19.1 build now succeeds on commit `e76c93ba`; app start logs show Next 15.5.28, `/login` is 200, and unauthenticated `/dashboard` redirects to login. Anonymous requests through Cloudflare Access receive 302. This does not verify owner OTP or authenticated app data.
- Official D1 import docs confirm the import format must be SQLite-compatible SQL; PostgreSQL dump syntax cannot be imported directly. They document a 5 GiB per-file import ceiling, while the Free plan still has a 500 MB per-database limit, 5 GB account aggregate, and 100,000 daily written-row quota. The current local Postgres restore is ~973 MB, 270/274 tables, and 1,583,520 rows, so conversion, exact per-domain size planning, and quota-aware staging are required before bulk data import. No full-database import has occurred.
- Current Cloudflare read-only D1 status confirms dataset key `symbol_daily_returns_v1` remains 99,000 / 261,678 rows and `loading`; its physical table is `symbol_daily_returns` (14 columns), not an app data authority. The remaining 162,678 verified R2 rows are split into nine local SQL chunks at 20,000 source rows/day, budgeting 60,000 row writes/day for the two existing indexes and leaving 40,000 headroom. A previous one-day 72,678-row queue is not safe under that indexed-write estimate and is not to be used. Corrected count/schema/status queries all report zero D1 rows written.
- Read-only Supabase SQL is currently available for metadata even though the application REST path remains restricted. Latest database measurement is 829,328,531 bytes at 2026-11-17 21:17 UTC; four post-dump cohorts changed and are reconciled in `DATABASE_INVENTORY.md`. The Render deploy for commit `2c7d6804` is live; it is still a bridge host with Supabase dependencies and this does not complete the Cloudflare migration.
- The authenticated D1 Free dashboard currently shows 99.02k/100k daily rows written and 25.35 MB/5 GB storage. Account GraphQL analytics returns 99,001 archive rows written on Nov 17 but 198,014 on Nov 16, which conflicts with the published 100,000/day Free threshold. Do not run further import chunks until the daily reset and a fresh counter check; retain the 20,000-row chunk plan only as a ceiling pending reconciliation of the Nov 16 overage. D1 Free daily counters reset at 00:00 UTC per [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
