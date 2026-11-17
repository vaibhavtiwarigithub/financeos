# Scheduler Rationalization — Architecture and Rollout

Status: First bounded phase deployed and catalog-verified 2026-11-09; natural post-migration run verification pending. Broader cadence reductions remain unaudited.

## User intention

Reduce schedule-list complexity while preserving each existing job's purpose, timing, reliability, provider budget, market boundary, and safety deadline.

## Current architecture and evidence

Production has 143 active `pg_cron` rows. Six council rows call the same per-market endpoint and have identical commands within each market. India has windows `04-05`, `07-08`, and `11-12` UTC; US has `13-16`, `18-20`, and `22-23` UTC. All are weekdays at quarter-hour intervals. The application independently defers non-quarter-hour invocations before database access. Recent production history confirms each of the six schedules has naturally run. No call volume, model roster, budget, window, endpoint, or queue contract needs to change to represent those windows with two cron rows.

The remaining schedules are not assumed redundant. Several encode market-local/DST admission, separate trading-safety deadlines, retries after source publication, or independent producer/evaluator stages. They require a dependency and freshness audit before consolidation.

## Approved first phase

- Keep one active council job per market: `kairos-council-india` and `kairos-council-us`.
- India schedule: `*/15 4-5,7-8,11-12 * * 1-5`.
- US schedule: `*/15 13-16,18-20,22-23 * * 1-5`.
- Preserve each surviving job's existing command exactly; remove only the four duplicate schedule rows after verifying same-market command and window preconditions.
- Preserve every original UTC firing instant, weekday restriction, market parameter, endpoint, timeout, quarter-hour admission guard, daily symbol/budget limits, subscription queue behavior, and shadow-only contract.
- Do not change execution or provider-call volume. This reduces active scheduler rows by four (143 to 139), not scheduled invocations.
- Migration must fail closed if the expected names, active states, commands, or source schedules differ from the audited catalog. Do not edit historical run rows.

## Explicit non-goals

No broad dispatcher, new queue/table/RPC, new schedule, retry-policy change, frequency change, provider/model call, strategy/scoring/risk change, live/paper behavior change, credential access, paid service, or safety-job consolidation. Do not consolidate different endpoints merely because they fire at similar times.

## Verification and rollback

Verified: full application/acceptance CI and clean database migration replay passed; the exact-SHA production Vercel deployment is READY; the production migration applied; a read-only catalog query confirms exactly two active schedules with unchanged per-market commands and the full original six-window union, and confirms all four obsolete names are absent. The active catalog count is 139 versus 143 before migration.

Pending: observe natural post-migration runs for both markets and compare schedule-level run history and queue freshness. Until then, catalog equivalence is verified but runtime equivalence is not. Roll back by restoring the four original exact windows to the same endpoint/market commands and returning the two retained jobs to their catch-up windows. Keep the four-row reduction only if both markets continue to drain within the existing freshness contract.

## Later audit queue

Inventory other schedules by endpoint, market, due time, dependency, completion deadline, retry semantics, idempotency, natural run evidence, and safety impact. Consider grouping only schedules with equivalent command and windows or deterministic post-label evaluators whose readiness is already freshness-gated. Preserve independent safety checks, market-local time guards, DST pairs, post-close retries, and producer failure visibility. Any new schema or dispatcher architecture needs its own explicit architecture and approval before implementation.


## November 12 free-tier beta

Reuse the existing New York intraday time formatter and the two exchange date
formatters. Each formatter retains its original locale, timezone and options.
Keep existing inputs, stale-data handling, time gates, schedules and outputs.
Compare a fixed full-session replay before and after. The production success
criterion is a projected 30-day Active CPU total below three hours across five
market sessions. A local benchmark measures only the evaluator.

Bound price-cache write amplification at the existing restatement trigger,
where concurrent writers compare against the locked previous row. Retain the
stored close only for Yahoo adjusted bars over 60 UTC days old when the close
alone changes by less than one part per million and the provenance matches.
Retain all existing restatement rows. Recent bars, other price fields,
provenance changes and material corrections use the existing trigger path.
Verify the trigger with an isolated PostgreSQL replay before applying. To
roll back, restore the original trigger function body and pinned search path.

The storage target still requires a full restorable backup and reviewed
retention cohorts. The precision guard limits new growth and does not reclaim
existing bytes.

## Render recovery during the Vercel pause

The Render service sets NEXT_PUBLIC_KAIROS_RECOVERY_MODE=1 and uses only the public
Supabase endpoint and publishable key. Existing password sign-in establishes
the owner session. The dashboard uses that session to read recent research
under RLS, with no admin credential. Middleware limits the recovery host to
the sign-in and dashboard paths and rejects API and other application routes.
The recovery view independently requires the verified owner. Vercel retains
its existing application flow when this setting is absent. Check the deployed
login page, anonymous dashboard redirect and rejected API, then have the owner
sign in to verify actual data access. Keep deployment on the tested branch
until the shared production branch contains the recovery and CPU fixes.
