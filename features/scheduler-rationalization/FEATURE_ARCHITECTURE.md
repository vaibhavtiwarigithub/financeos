# Scheduler Rationalization — Architecture and Rollout

Status: Owner approved 2026-11-09; implementation begins with the bounded council-row consolidation below.

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

Before production apply, pass clean migration replay and full application/type checks. After apply, query the exact two active schedules and unchanged commands; verify the original six windows are represented and four old names are absent. Then observe natural per-market runs and compare schedule-level run history and queue freshness. Roll back by restoring the four original exact windows to the same endpoint/market commands and returning the two retained jobs to their catch-up windows. Keep the four-row reduction only if both markets continue to drain within the existing freshness contract.

## Later audit queue

Inventory other schedules by endpoint, market, due time, dependency, completion deadline, retry semantics, idempotency, natural run evidence, and safety impact. Consider grouping only schedules with equivalent command and windows or deterministic post-label evaluators whose readiness is already freshness-gated. Preserve independent safety checks, market-local time guards, DST pairs, post-close retries, and producer failure visibility. Any new schema or dispatcher architecture needs its own explicit architecture and approval before implementation.
