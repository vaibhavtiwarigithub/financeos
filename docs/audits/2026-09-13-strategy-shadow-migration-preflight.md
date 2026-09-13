# Strategy-shadow migration preflight — 2026-09-13

## Scope

This was a deployment preflight for the owner-approved, non-executing
strategy-template shadow contract in commit `6499f8ae`. It was read-only: no
migration was applied, no migration-history row was changed, and no paper or
broker order path was enabled.

## Commands and result

The Supabase CLI was authenticated using the configured project access token
and targeted project `dionkikgdmlaotvtbnfr`.

1. `supabase migration list --project-ref dionkikgdmlaotvtbnfr` showed remote
   migration versions not present in this checkout.
2. `supabase db push --dry-run --include-all --skip-vault` refused with
   `LegacyDbPushMissingLocalError`: remote migration versions are missing
   locally.
3. The configured raw database URL was deliberately not used as a bypass. The
   CLI rejected its legacy/unparseable form, and its value was neither printed
   nor modified.

The history gap includes `20260911134352`, a production live-exit migration
whose local timestamp/content counterpart is not the same repository object.
It also includes many other remote versions. Therefore this checkout cannot
prove a clean-schema reconstruction or safe ordering for a new schema change.

## Verdict

`20260802143000_strategy_template_shadow_configs.sql` is locally repaired but
**not deployable from this checkout yet**. Applying it through a raw SQL client,
forcing a migration push, or editing migration history would create an
unreviewable divergence and is prohibited.

## Required continuation

1. Identify the authoritative repository checkout/branch that produced the
   production migration history and recover the missing migration files under
   their actual versions.
2. Reconcile repository lineage without editing production history.
3. On an isolated database, apply the reconciled history plus the local
   template-shadow migration and run the contract acceptance cases.
4. Only then perform a normal, non-forced deploy and verify the owner API
   returns its typed, non-executing configuration result.

Until then, `live_auto_enabled` remains false and the strategy contract cannot
create a paper position, proposal, broker call, or live order.
