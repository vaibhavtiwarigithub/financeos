# Live-exit ladder migration reconciliation — 2026-09-13

## Scope and safety boundary

This is a read-only reconciliation of the FinanceOS production schema and
migration history. It did not apply a migration, alter a broker setting,
enable `live_auto_enabled`, or place an order.

## Verdict

The production schema is **not reproducible from this checkout**, and the
current shadow writer has a real production-schema incompatibility. This is
not merely a timestamp mismatch.

`live_auto_enabled` is false, so the failure cannot submit a live sell today.
It can, however, silently lose the very shadow evidence needed before any live
enablement decision. Treat the ladder's live-readiness proof as blocked until
the compatibility repair is deployed and observed.

## What production actually records

The linked FinanceOS project (`dionkikgdmlaotvtbnfr`) has these history rows:

| Version | Name | Present locally? |
| --- | --- | --- |
| `20260910022710` | `live_exit_ladder_parity` | No |
| `20260911134352` | `live_exit_ladder_safety` | No — the checkout instead has `20260911122939_live_exit_ladder_safety.sql` |

The production tables exist and include the two safety columns the current
monitor consumes: `live_position_state.state_mode` and
`direction_flip_armed_session`. The local safety migration's two `ALTER ...
ADD COLUMN IF NOT EXISTS` clauses are therefore semantically compatible with
that narrow part of production, but they are not proof of whole-schema or
history equivalence.

## Reproducibility gap

The missing production base migration matters. Production has constraints not
created by local `20260911122939_live_exit_ladder_safety.sql`, including:

- positive-value checks on `live_position_state.highest_price`,
  `trailing_stop`, and `partial_qty`;
- an action check on `live_exit_ladder_shadow`;
- a different nullability shape for several shadow-observation fields.

The local migration's `CREATE TABLE IF NOT EXISTS` does not add any of these
when a table already exists, and a fresh environment created only from this
checkout would not receive them. It cannot stand in for the absent
`20260910022710` base migration.

## Active compatibility defect

Production enforces this constraint on `public.live_exit_ladder_shadow.action`:

```sql
CHECK (action = ANY (ARRAY[
  'none', 'stop_full', 'partial_target', 'target_full', 'time_stop',
  'runner_hold'
]))
```

`lib/trading/live-exit-monitor.ts` now selects `action = 'score_exit'` after
a confirmed two-session holding-score deterioration. In shadow mode it inserts
that value into `live_exit_ladder_shadow`, but does **not** inspect the insert
error. PostgreSQL will reject that row. The monitor has currently logged only
seven `partial_target` rows, so production has not exercised the failing arm.

This is a data-integrity failure in the measure-only path, not evidence that
score exits work in shadow. In executable mode the shadow insert is skipped,
so the incompatibility would not prevent a sell; that makes repairing and
proving the shadow path before any enablement more important, not less.

## Required repair sequence

1. Recover the source SQL for remote migration `20260910022710` and the exact
   remote `20260911134352` from the checkout/account that applied them. Do not
   infer it from table shape alone and do not edit `schema_migrations`.
2. Restore the base migration to repository history under its actual remote
   timestamp, or create an Architect-approved, auditable baseline-import plan
   that reproduces it for a clean project. Do not add a duplicate version or
   reapply the local `20260911122939` to production.
3. The local, unapplied follow-up migration
   `20260913103000_live_exit_ladder_shadow_action_contract.sql` replaces the
   production action check with a governed vocabulary that includes
   `score_exit` and retains legacy `time_stop` rows. The table check and the
   TypeScript writer are covered by a contract test. It must be reviewed with
   the recovered lineage before any deployment.
4. The local monitor now makes the shadow insert fail closed for
   observability: it captures its error,
   emit a critical health incident, and record an explicit run result rather
   than returning a misleading clean run. This must remain non-executing while
   `live_auto_enabled=false`.
5. On an isolated database first, prove:
   - the recovered base + safety migrations build the exact required tables,
     constraints, comments, RLS, and grants;
   - all ladder actions, including `score_exit`, can be written;
   - an invalid action is rejected;
   - a forced insert failure creates the health signal and submits no order;
   - state mode isolation and a fractional partial target still work.
6. After deployed schema/code verification, wait for a real scheduled shadow
   run that records a normal action. A score-exit synthetic test belongs only
   in an isolated/rolled-back environment; do not manufacture production
   portfolio state to make the dashboard look complete.

## Read-only verification queries

```sql
select version, name
from supabase_migrations.schema_migrations
where version in ('20260910022710', '20260911122939', '20260911134352')
order by version;

select conrelid::regclass as table_name, conname,
       pg_get_constraintdef(oid, true) as definition
from pg_constraint
where conrelid in (
  'public.live_position_state'::regclass,
  'public.live_exit_ladder_shadow'::regclass
)
order by table_name::text, conname;

select action, count(*), max(evaluated_at) as latest_observation
from public.live_exit_ladder_shadow
group by action
order by action;
```

## Non-actions

- No migration was applied.
- No migration-history row was inserted, edited, repaired, or deleted.
- No live setting, broker setting, position, order, or score was changed.
