# Complete holdings in scheduled email briefings

Owner approved the implementation on 2026-11-04 (“fix it”).

## Change

- The existing US and India morning/evening editions now load the full paper
  holdings set with stable pagination instead of a 10-row limit.
- Each email includes a compact, market-local paper holdings table with quantity,
  average cost, stored mark, value, unrealized dollar/percentage P&L, stop,
  target, open date, and mark-row update time.
- Each account's latest complete immutable Holding Risk snapshot feeds a
  separate live holdings table. It includes all ordinary and attention holdings,
  keeps accounts separate, masks account IDs, and shows source capture time.
- A newer failed/partial account run is shown beside its last complete snapshot.
  Unavailable account states are never described as flat. If a full paper/live
  snapshot read fails or cannot finish pagination, the route returns 503 and
  sends no partial email.
- Tables use only stored data; email generation makes no per-symbol quote or
  broker request and adds no schema, persistence, schedule, or order behavior.

## Validation

- Focused briefing/pagination tests: 24 passed.
- `npx tsc --noEmit --incremental false`: passed.
- Full Vitest suite: 4,742 passed, 8 skipped, 2 failed in the unrelated
  `tests/event-vocabulary.test.ts` (event count cap and missing election-control
  magnitude unit). The focused briefing tests passed in the same run.
- `npm run build`: passed; optimized production build generated all 77 routes.
- Production deployment and natural scheduled-email verification: pending.

No scheduled email or broker route was manually invoked as a test.
