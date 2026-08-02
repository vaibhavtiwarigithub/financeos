# Feature-Pack Validation: P0 Result

> Shipped: 2026-08-02
> Commit: see the matching `feat: add feature pack catalog` history entry.

## Delivered

- Added `lib/feature-packs/catalog.ts`, a typed read model of current feature
  lifecycle and instrument applicability. It records active v1 facts,
  measure-only candidates, observed-only facts and unsupported indicators.
- Research Journal now labels the record's instrument family and separates
  current v1 facts, measured-only candidates and inapplicable facts. It reads
  stored decision evidence only and makes no provider call.
- Strategy Library now says plainly that templates are reference/manual tools.
  Each card distinguishes manual Scanner conditions, shadow-only conditions and
  Scanner-unsupported conditions. Its buttons are labeled manual scan/backtest.
- Added regression tests for ETF fundamental exclusion, leveraged-ETF
  classification precedence, and explicit template-condition support states.

## Not delivered intentionally

- No MACD, ADX, fundamental candidate, strategy template, score, threshold,
  paper trade, live proposal, position, exit, sizing, broker or Router behavior
  changed.
- No database migration or `feature_registry` lifecycle mutation was made.
- P1 technical measurement, P2 PIT fundamental qualification, P3 replay/shadow,
  P4 paper champion, and P5 specialist packs remain governed by the architecture
  and their existing feature specifications.

## Verification

- `npx vitest run tests/feature-pack-catalog.test.ts tests/research-journal-controls.test.ts tests/scoring-evidence-contract.test.ts`
- `npx tsc --noEmit`
- `npm run build`
