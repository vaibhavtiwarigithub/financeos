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

## Follow-up governance hardening (2026-08-02)

- Replaced the legacy automatic `active` status with `measure_only`. The database
  migration renames legacy rows and the weekly evaluator can no longer create a
  score-eligible lifecycle state.
- Research evidence now writes `measured_feature_values`, an explicit
  observation-only payload. No current reader uses it for score, eligibility,
  sizing, paper/live proposals, exits, or broker execution.
- The existing EdgeScout/EdgeIC technical trial family remains the P1 source of
  truth. P2 needs source-qualified market-local reported facts, P3 needs the
  sealed walk-forward gate, P4 remains disabled, and P5 needs specialist data
  contracts; none are represented as completed functionality.
- Dashboard -> Upgrade Path now registers all of these gates separately for the
  selected US or India market: technical calibration, PIT fundamental
  qualification, specialist packs, and challenger validation. The page reports
  actual ledger coverage where one exists and an explicit idle state where no
  evidence collection has been approved.

## Verification

- `npx vitest run tests/feature-pack-catalog.test.ts tests/research-journal-controls.test.ts tests/scoring-evidence-contract.test.ts`
- `npx tsc --noEmit`
- `npm run build`

## Independent review correction — 2026-08-02

Adversarial review of `17876da4..a51ae122`. Findings and the fixes applied.

**HIGH — the Research funnel reported live inputs as inapplicable.**
`instrumentFamily()` in `lib/feature-packs/catalog.ts` matched only the
`InstrumentKind` vocabulary (`us_equity`, `india_equity`, ...). Journal rows
supply `identity.asset_type` from `JournalAssetType` (`company`,
`india_company`), and `identity.instrument_kind` is `null` for any decision
written before instrument capture existed. Both inputs therefore resolved to
`unknown`, and `featureAuditForInstrument()` returned every `active_v1`
feature as *inapplicable*. The funnel then told the owner that RSI(14),
EMA20/50, 20-day trend, volume, ATR, sector-relative P/E, profit margin, ROE,
EPS sign and revenue growth did not apply to a decision those inputs had in
fact scored.

Production scope at the time of review, `decision_observations` over 30 days:
US 1,744 rows with 726 carrying an instrument kind, India 410 with 197. About
58% of recent decisions rendered the false panel.

Fixed by teaching `instrumentFamily()` the journal vocabulary, and by making
`featureAuditForInstrument()` return empty lists for an `unknown` family —
an unclassified instrument is unknown, not proven incompatible. The funnel now
states plainly that the decision stored no classification and points at the
quant audit instead.

**MEDIUM — three fundamental conditions were labelled shadow-gated.**
`FUNDAMENTAL_CONDITION_STATE` marked `fcf_yield_min`, `debt_equity_max` and
`gross_margin_min` as `measure_only`, which the Strategy Library rendered as
"Shadow evidence required before use". All three ship inside
`AlgoStrategy.scan_filters` and are sent to the Financial Datasets screener by
`app/api/agents/research/scan/route.ts`, so the manual Scanner does evaluate
them. Corrected to `manual_only`. `macd_cross_up` remains shadow-gated and
`price_above_ma200` / `volume_surge` remain unsupported — the scan route reads
only `rsi_min`, `rsi_max` and `price_above_ma50` from `conditions.technical`.

**LOW — a provider error was recorded as a narrative timeout.**
The 10s advisory-thesis race in `lib/research-agent.ts` returned the same
`narrative-timeout` fallback for a rejected `callLLM` as for an elapsed timer,
so an outage read as latency in the LLM ledger. The catch path now labels
`narrative-error` with `durationMs: 0`.

**LOW — stale vault paths in user-visible strings.** `ScannerPage`,
`PortfolioRiskPage` and the `execute-order` no-keys error still said
"Admin → Vault". Updated to "Settings → System → API Vault".

### Verified clean

- **Money path.** `trader`, `kite/order`, `lib/kite.ts` and
  `execute-order.ts` changes are wording only; every gate predicate is
  byte-identical. Broker routing still resolves through `active_broker_us` /
  `active_broker_india`.
- **Removing the legacy global broker picker changes no configuration.**
  `PATCH /api/settings/risk-profile` applies `broker` only under
  `if (broker !== undefined)`, so omitting it leaves the stored value
  untouched.
- **Settings labels match reality.** `lib/trading-mandate.ts` never reads
  `strategy_config`, so the claim that entry threshold, stop, target and
  horizon are market-local is accurate. Stop/target/threshold state still
  round-trips into `strategy_config` on save, but nothing on the money path
  reads those columns.
- **Deep links.** `?tab=profile|preferences|access` alias to `account` and
  `?tab=agents` to `trading`; `/dashboard/admin` still redirects to
  `?tab=admin`. The four MCP OAuth callbacks still emit `?tab=agents` and land
  correctly through the alias.
- **Admin surface.** Removing the duplicate sidebar item removed no access:
  the `admin` tab was already in the tab list, and `/api/admin` gates on
  `role in (admin, superadmin)` server-side.
- **Feature-registry governance.** Production `feature_registry_status_check`
  is `('proposed','quarantined','measure_only','retired')`; `active` is gone
  and no code writes it. `nextFeatureRegistryStatus()` has no edge that reaches
  a score-eligible state. Nothing reads `measured_feature_values`.
- **Direction stays deterministic under the thesis timeout.**
  `resolveSignalDirection()` uses `llmDirection` only to compose a note; an
  empty narrative cannot change eligibility. The losing race branch carries a
  `.catch`, so no unhandled rejection and no leaked timer.
- **Screener aliases cover the real filters.** `pe_ratio` and `profit_margin`
  are the only legacy field names present in `scan_filters`, and both are in
  `LEGACY_FIELD_ALIASES`. Symbol extraction still requires a non-empty
  `ticker`/`symbol`, so no arbitrary symbol can enter research.
- **RSI alias.** `computeTechnicals()` emits `rsi14`; `ScoreTrackerPanel` read
  `evidence.rsi`, which never existed. The `rsi14 ?? rsi` fix is correct.

### Not verifiable locally

The Financial Datasets `POST /financials/search/screener` request and response
shape could not be exercised: the account balance is $0.00. The `search_results`
key and the `{filters, limit}` body are taken from the provider's published
contract, not from an observed response.

### Gates

`npx tsc --noEmit` clean · `npx vitest run` 1506 passed / 7 skipped ·
`npm run build` clean · `git diff --check` clean.
