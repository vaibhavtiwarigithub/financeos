# Council evaluator operational repair — October 23, 2026

## Reproduced defects

The evaluator scanned the complete observation-label history separately for two
markets, two cohorts and four horizons. Within each page it reloaded runs and
member forecasts. The same historical labels were therefore repeatedly read,
including observations without any council run. It inserted each cell group
before later reads finished, permitting an incomplete newest batch on failure.
It lacked an agent-run start/completion/error receipt.

## Bounded implementation

- Reuse `fetchAllRows` and its 200-page failure bound with total ordering.
- Load terminal council runs and completed forecasts once. Read labels for only
  those observation IDs in chunks of 100, sharing all four horizons across both
  declared decision-time cohorts. No history cutoff or new eligibility filter.
- Project delayed forecasts' frozen deterministic score and prediction-contract
  identity rather than repeating entire research packets for every member.
- Publish every calculated IC cell in one atomic insert, only after all reads
  succeed. Keep historical batches unchanged. Preserve availability-aligned
  labels, exact research benchmark identity, initial/debated series, version
  partitioning, paired baseline/blend and insufficient-evidence gates.
- Reject null scores as missing, rather than coercing them to zero.
- Write existing `agent_runs` start/done/error receipts with safe phase names.
  If the function dies, the existing watchdog can reap its running receipt. A
  completion-receipt failure after successful publication is reported accurately.

Tests exercise both markets, every decision-time cohort/horizon, exact paired
counts and IC, delayed subscription labels/version identity, read failure,
benchmark failure and atomic-write failure. No test calls a model or broker.

## Service recovery remains a separate verification

At 01:30 UTC October 24 the system read showed six idle client sessions, one
active and three idle in transaction, against max_connections 60. This does not
establish current connection exhaustion. The latest checked IC batch was still
October 22 at 23:48 UTC. Later small management SQL checks timed out.

The signed-in Supabase Database Observability page was reached at about 01:45
UTC; CPU, memory, IOPS, throughput, connections and disk metrics all said
"Unable to load data." Its displayed zero-GB placeholders are not a measurement
of real database storage. The official [Supabase status page](https://status.supabase.com/)
reports elevated Management API errors in multiple regions. This is relevant
context, not proof of the cause of FinanceOS runtime database timeouts.

Do not claim restored burst budget, successful fresh evaluation or resolved
runtime connectivity until production readback proves it. No database restart,
paid compute, session termination, historical financial changes, inference,
roster changes, manual trading cron or broker order is part of this repair.
