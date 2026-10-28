# Verified duplicate index cleanup — 2026-10-28

## Finding

The production Performance Advisor reported duplicate indexes. Catalog inspection
confirmed two identical non-constraint indexes on `experiment_runs`:

- `er_gate_idx` duplicates `er2_gate_idx` on `(gate_pass, run_type)`; both had
  zero scans.
- `er_strategy_idx` duplicates `er2_strategy_idx` on
  `(strategy_version_id, created_at DESC)`; the retained `er2_strategy_idx` had
  recorded scans while the duplicate had zero.

`watchlist` had two equivalent unique constraints on `(user_id, symbol)`. The
application upsert targets that column pair; the migration removes only
`watchlist_user_symbol_uniq` and retains `watchlist_user_id_ticker_key`.
Production catalog inspection showed the table was about 320 KiB and estimated
at 299 rows. No app code names the removed index identifiers. No user data is
deleted or rewritten.

## Change and verification

Migration `20261028145623_remove_redundant_indexes.sql` removes the redundant
objects only. It was applied through Supabase's migration operation and appears
in the production migration ledger at version `20261028145623`. A follow-up
catalog read found only `er2_gate_idx`, `er2_strategy_idx`, and
`watchlist_user_id_ticker_key`; both duplicate experiment indexes and the extra
unique constraint are absent. The Performance Advisor no longer reports a
duplicate-index finding. The focused regression test pins the exact removal
scope and retained upsert contract. The authenticated write path was not invoked
because doing so would mutate the owner's watchlist. This is index/constraint
maintenance only; no Supabase plan, policy, RLS, scoring, trading, or app
behavior changes.

The same review found two permissive `app_user_roles` SELECT policies. Their
production predicates were owner-email visibility OR self-row visibility. A
second migration, `20261028145820_merge_equivalent_app_user_roles_read_policies`,
replaces those two with one policy containing the exact same OR expression.
Production `pg_policies` confirms one authenticated SELECT policy with both
predicates; no write policy or table grant changed. The Performance Advisor no
longer reports the multiple-permissive-policy warning.

## Other findings left untouched

The production advisor still reports informational unindexed foreign keys.
They were not bulk-indexed: each needs query-path/usage evidence and new indexes
would add write and storage cost on the free tier. Service-only RLS tables,
`pg_net` placement, the intentionally caller-scoped `get_daily_ai_count`
security-definer RPC, and Auth password settings likewise remain unchanged
pending exact application/operational review.
