# Strategy Portfolio Lab — implementation result

Date: 2026-10-30
Architecture: `FEATURE_ARCHITECTURE.md` (approved P0; non-executing).

## Delivered flow

1. Learning exposes a bounded template discovery and comparison panel. It supports three fully price-based daily templates; unsupported clauses remain visible and are never silently discarded.
2. Owner-selected symbols/horizon run a deterministic, cost-aware historical diagnostic on cached bars, with a temporal 70/30 split, next-open execution, equal-weight symbol sleeves, benchmark pairing, and benchmark trend/volatility diagnostics. The price proxies are not macro regimes.
3. Registration freezes the rule/config fingerprint and trial family. The API enforces ten-symbol and three-non-retired-config per-market bounds; it rejects arbitrary rules.
4. Historical eligibility is not promotion evidence. The owner must explicitly start an eligible shadow. No shadow configuration was automatically started during implementation.
5. Natural ResearchAgent runs then persist immutable config/symbol/session decisions and horizon-matured net outcomes with source/basis provenance. Learning compares the candidate to deterministic entry eligibility on the same cohort and shows pending/mature labels, overlap groups, and benchmark proxies.
6. No data from this lab is consumed by scores, paper/live portfolios, sizing, exits, proposals, or broker/order paths. There is no automatic promotion.

## Production schema and access

Forward-only migrations `20261030173804_strategy_template_shadow_flow` and `20261030173857_strategy_template_shadow_service_acl` were applied to the connected production project and verified in migration history. All four tables exist with RLS enabled; lifecycle RPCs exist; service role has read-only access to configs/events and read+insert access to immutable decisions/outcomes, with no update/delete/truncate privileges. Authenticated owners have read-only access; anon has no access.

## Verification

- Full Vitest suite: 4,670 passed, 8 skipped (570 test files passed; 1 skipped file).
- Final focused strategy suites: 40 passed across 4 files.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- Production migration tracker and exact table/RPC/privilege state: verified after both migrations.
- The standard `.next` output path hits an existing Windows reparse-point `EINVAL`; production build succeeded using `NEXT_BUILD_DIST_DIR=.next-strategy-lab-build`, including TypeScript validation and all 77 static pages. Next emitted an existing Supabase Edge Runtime compatibility warning. GitHub clean migration replay and production deployment verification remain release gates.
- No strategy shadow has begun collecting yet. After release, owner must use Learning → Strategy discovery & forward tournament to scan, inspect a selected template, register it, then explicitly start the forward shadow. Evidence maturity takes the declared horizon; until then performance is insufficient, not a pass.

## Remaining release gates

Run the isolated production build and repository secret scan, push the verified commit to `main`, observe GitHub acceptance (application/typecheck/clean migration replay), then verify the exact production Vercel SHA and READY status. Do not manually invoke research or trading schedules to manufacture observations.
