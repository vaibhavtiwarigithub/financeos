# Template-shadow lifecycle recovery

Status: **blocked pending explicit architecture approval; no schema, configuration,
shadow, paper, or live action was taken.**

Scope: recover the predeclared external-strategy template/combination shadow
configuration path. This audit is limited to that path; it does not alter the
approved scoring-genome `shadow_paper` lifecycle in migration 170.

## Verified production state

Read-only production query on 2026-09-13:

| object | state |
|---|---|
| `public.strategy_template_shadow_configs` | absent |
| `public.strategy_template_shadow_events` | absent |
| `create_strategy_template_shadow_config(...)` | absent |
| `public.trial_family_ledger` | present |
| `register_trial(...)` | present |

The deployed `trial_family_ledger` / `register_trial` seam is useful for the
offline replay work. It is **not** a template-shadow lifecycle.

## The current path is nonfunctional

`app/api/strategies/template-shadows/route.ts` calls a table and RPC which do
not exist in production. If reached, GET returns a database error and POST
returns a generic `409`; neither is a valid owner workflow.

The only migration intended to create those objects,
`supabase/migrations/20260802143000_strategy_template_shadow_configs.sql`, is
committed but deliberately unapplied. It must not be applied as it stands.

## Why the migration and API cannot be deployed unchanged

1. The table requires `rule_version` and `trial_family_id` with no defaults.
   The RPC accepts neither and inserts neither. Every POST would fail its own
   NOT NULL constraints.
2. The route fingerprints only `{market, kind, template_ids}`. It omits the
   declared operator, weights, rule version and trial family. Distinct trials
   can therefore collide before the database ever sees them.
3. The RPC has the same incomplete identity and can be called independently of
   the route. An API-side hash is not an integrity boundary.
4. The lifecycle event ledger is never written. Its `state` column and
   `retired_at` are directly mutable without an event, reason, evidence snapshot
   or actor, despite the migration claiming the event table is authoritative.
5. SQL accepts invalid combinations: a `template` may carry several ids, a
   `combination` may carry `operator='single'`, and `weights` has no shape or
   sum validation. The route checks only one of those cases; privileged callers
   bypass it.
6. `template_ids text[]` has no referential or market-integrity check against
   `strategy_templates`. A deleted, unknown, or cross-market template can be
   recorded as an apparently valid experiment.
7. Nothing compiles a config into a frozen `strategy_versions` challenger,
   invokes the validation engine, writes `shadow_decisions`, or retires/pauses a
   config. The config endpoint is not wired to a worker or UI consumer. Creating
   the table alone would create inert rows, not forward shadows.
8. Capacity differs across documents: the migration enforces three active
   template configs **plus** one combination; the approved Portfolio Lab says
   at most three active template shadows per market and at most one combination.
   The owner must decide whether the absolute cap is three or four before a
   state-changing RPC is written.

## Recovery contract required before implementation

The approved Portfolio Lab P0 needs a concise architecture revision that fixes
the above explicitly. The smallest safe contract is:

1. An immutable config has canonical sorted template lineage, market, kind,
   operator, validated weights, compiler/rule version, and trial-family id.
   The **database** derives/verifies the canonical fingerprint from all of them.
2. One transactional service-only creation RPC validates template existence and
   market compatibility, enforces the agreed cap under an advisory lock, writes
   the config **and** an immutable `created` event, and returns a typed result.
3. One transactional lifecycle RPC is the sole writer of projected state. It
   appends an event containing actor, reason and sealed evidence snapshot before
   updating the projection. Direct state writes are revoked or rejected.
4. A compiler accepts only deterministic grammar supported by
   `lib/strategy-replay/rule-spec.ts`; it freezes source-template lineage and
   produces a separate non-executing challenger. Unsupported templates refuse
   with a recorded reason.
5. The existing validation/shadow system may be reused only after a mapping is
   specified between template config, generated version, validation experiment,
   and each `shadow_decision`. No automatic champion promotion, paper fill,
   broker proposal, or live order is permitted.
6. The comparison view reports the market locally and defaults to
   `insufficient_evidence`; it reads only immutable config and append-only
   evidence.

## Acceptance evidence

Before deployment, prove all of the following in a rolled-back transaction or
an isolated database branch:

- incomplete identity inputs, duplicate ids, unknown/cross-market templates,
  invalid operator/weight/kind combinations, and capacity races fail;
- differing operator, weights, rule version, or trial family produce different
  fingerprints and increment the intended trial accounting exactly once;
- every permitted transition creates one append-only event and no transition is
  possible without one;
- a config cannot create an agent signal, paper fill, proposal, exit, broker
  call, or live order; mutation tests demonstrate each boundary;
- a generated challenger is market-local and cannot enter `shadow_paper` until
  its deterministic validation is passed;
- endpoint tests assert typed refusals instead of masking schema failures as
  `409`.

## Decision needed

The external-strategy-discovery architecture remains marked **DRAFT**. Approve
the revised P0 lifecycle contract above (including the absolute per-market
capacity) before building or applying any migration. Until then, the safe,
already-working work is the measure-only replay seam and its trial ledger; the
template-shadow endpoint must be treated as dormant and nonfunctional.
