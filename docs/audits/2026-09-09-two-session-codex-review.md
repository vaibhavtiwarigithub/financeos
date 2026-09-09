# Two-Session Adversarial Review (`6a176ffe..b763fa39`)

**Reviewed:** 2026-09-09
**Verdict:** build/tests pass, but the Manual Trade Guardian is not safe to rely on yet and the new live-count and IC-drift claims overstate what their data measures. No live-order, schema, schedule, scoring, or trading behavior was changed by this review.

## P0 — fix before relying on the Guardian

### 1. The first successful snapshot labels existing holdings as new manual buys

`lib/trading/manual-fill-detection.ts:63-85` defaults an absent prior quantity to zero. Production currently has zero ledger rows. The first successful run therefore interprets every existing holding as an increase and can emit a stop suggestion and warning for each one.

**Fix:** introduce an explicit account bootstrap snapshot with `classification=baseline`, no alert, and no stop proposal. Only a later quantity transition may be classified. Claim the run atomically so two first runs cannot both bootstrap.

### 2. Partial sells are discarded and corrupt the next comparison

`lib/trading/manual-fill-detection.ts:63-66` skips every `delta <= 0`; only a symbol that disappears completely gets a zero row at lines 88-92. A 10→4 sell leaves the baseline at 10. A later 4→10 buy then appears unchanged and is missed.

**Fix:** append every quantity transition, including partial decreases. Attribute both buys and sells to broker-order fill deltas. Store the observed quantity separately from attributed delta/source.

### 3. Full exits are always called manual

`lib/trading/manual-fill-detection.ts:88-92` hard-codes `source: "manual"` without matching a SELL order. A Kairos exit is therefore mislabeled.

**Fix:** use one symmetric transition classifier for increases and decreases; never special-case disappearance as manual.

### 4. The append-only ledger can be truncated

Production grants include `TRUNCATE` for `anon` and `authenticated`. RLS does not apply to `TRUNCATE`, and the UPDATE/DELETE triggers do not intercept it. The entire evidence ledger can be erased despite the append-only claim.

**Fix:** revoke INSERT, UPDATE, DELETE, and TRUNCATE from client roles; permit service-role SELECT/INSERT only; add and test a TRUNCATE blocker. Apply through a checked-in migration.

### 5. Production schema changes have no repository migration

`agentic_position_ledger` and `learner_runs.live_trades_closed/live_win_rate` exist in production, but no matching migration is present under `supabase/migrations`. A clean environment cannot reproduce the deployed schema, and drift detection cannot prove it.

**Fix:** add idempotent reconciliation migrations matching the verified production shape and grants, then run migration-history and rollback tests. Do not rewrite old migration history.

## P1 — correctness and decision-safety

### 6. Fill attribution assumes one order exactly equals the holdings delta

`lib/trading/manual-fill-detection.ts:68-70` uses the first recent order whose cumulative `filled_qty` equals the entire delta. It cannot sum multiple fills, track incremental fill changes, consume an order once, or distinguish a stale same-size order. The route also cannot scope `broker_orders` to an account because that table has no account column (`app/api/agents/manual-fill-detect/cron/route.ts:92-103`).

**Fix:** persist broker account on every order; reconcile broker execution events by broker order ID and incremental filled quantity; allocate a holdings delta across eligible unconsumed fills; emit `unknown` when attribution is ambiguous. Never silently choose manual or agentic.

### 7. Missing cost basis is replaced with current price

`lib/trading/manual-fill-detection.ts:72-85` treats current price as entry cost, then publishes a precise stop. That is fabricated geometry, not a conservative fallback.

**Fix:** preserve null cost basis and mark the recommendation unavailable until broker fill/cost evidence exists.

### 8. The stop suggestion is not the same logic used by current PaperTrader entries

The route uses only `loadTradingMandate` at `app/api/agents/manual-fill-detect/cron/route.ts:106-117`, while the paper entry path can use dynamic risk/reward evidence. The source comment overclaims parity. `loadTradingMandate` also silently falls back to defaults on a DB failure.

**Fix:** call a shared strict exit-geometry resolver with explicit provenance, or clearly label a mandate-only fallback as such and withhold it if configuration is unavailable.

### 9. The schedule is not actually US market hours year-round

The production cron is `*/15 13-21 * * 1-5`. UTC does not move with US daylight saving time, and weekdays include exchange holidays. The route has no exchange-calendar gate.

**Fix:** schedule a broad UTC envelope and fail closed inside the route unless an authoritative US market calendar/session check says the market is open. Track skipped/non-session runs separately.

### 10. A SELL order is not a closed trade

`app/api/agents/learner/route.ts:164-183` counts every filled Robinhood SELL row as a closed live trade. Partial exits and multiple sell fills inflate it; buys and sells are not paired. At line 520 that proxy is added to the Phase-0 gate, so order activity can unlock learning behavior without an equivalent number of realized outcomes. `live_win_rate` is always null at lines 948-951.

**Fix:** build an immutable live-lot ledger that pairs fills and realizes quantity-weighted outcomes. Keep operational sell-order counts separate and never feed them into evidence gates. Market and environment must be explicit.

### 11. Code-version IC drift is structurally unable to report

The detector groups by exact deployed code version while the evidence rules require at least 20 qualifying sessions and at least 12 horizon-adjusted effective observations (`lib/learning/dimension-diagnostics.ts:30-40`). Production currently has no version meeting the floor; even 20 h10 sessions produce only two effective observations. Frequent deployments reset the group before it matures.

Its regression test (`lib/learning/ic-regression-alert.ts:48-89`) compares the latest mean with the standard deviation of as few as five prior version means. That is not the Benjamini-Hochberg test applied to each version’s IC-versus-zero p-value, so “BH-controlled regression” is inaccurate.

**Fix:** maintain a continuous per-session IC series independent of SHA. Use predeclared rolling/EWMA or changepoint monitoring and annotate deployment boundaries. Require paired pre/post or frozen replay evidence before assigning causality. Until enough history exists, show `collecting`, not a regression verdict.

## P1 — broker tradability missing from every live path

`lib/trading/execute-order.ts:188-200` validates syntax and a local BUY blocklist, but `lib/brokers/adapter-types.ts:20-27` has no broker capability method. The standalone Kite path submits at `app/api/kite/order/route.ts:296-303`, and protective GTT placement follows at lines 367-375, without a broker-authoritative instrument/side preflight.

**Fix:** implement the draft in `features/broker-symbol-tradability/FEATURE_ARCHITECTURE.md`. Require fresh, side-specific, exact-broker/account eligibility both in the central gateway and immediately before each adapter’s wire call. Persist the evidence and bind it to the atomic order reservation. Research-universe membership is never sufficient.

## P2 — property and UI correctness

### 12. USPS “verified” does not establish deliverability

`lib/property/address-verify.ts:64-81` accepts any HTTP 200 containing street and ZIP and says USPS matched a “real, deliverable address.” It ignores DPV confirmation, match count, corrections, and warnings.

**Fix:** require an unambiguous match and acceptable DPV result; preserve corrections/warnings as evidence. Otherwise return ambiguous/not-found rather than verified.

### 13. ZIP trend serves old/revised duplicates as if they were months

The collector retains rolling months under a revision-bearing `source_version`. `app/api/property/zip-trend/route.ts:22-37` orders oldest-first and limits 24 without selecting the newest vintage for each `as_of`. Once revisions accumulate, the newest months fall out and duplicate vintages distort 3/12-month UI calculations.

**Fix:** select the newest source vintage per `as_of`, take the latest 13 distinct months, then sort ascending for display. Add revision-duplicate tests.

### 14. ZHVI collection materializes a roughly 123 MB CSV

`lib/property/sources.ts:267-295` loads the entire national ZIP file into a string and then a full row matrix. A valid empty target-metro result is also returned as success. This is a memory/timeout and silent-source-drift risk.

**Fix:** stream/scan only target metro rows, enforce compressed/uncompressed size bounds and schema checks, and treat zero Austin/Phoenix observations as typed unavailable.

### 15. “Current balance” is only a scheduled amortization estimate

The amortization formula independently reproduced the fixture to floating-point precision; no math defect was found. But `components/property/AmortizationWorkspace.tsx:128` labels the result `CURRENT BALANCE`, assuming no extra/missed payments, recast, fees, or servicing differences.

**Fix:** label it `SCHEDULED BALANCE ESTIMATE`, allow the owner’s lender balance, and show the variance without overwriting either provenance.

## P2 — system map verification is too weak

`public/agent-diagrams/system-map.json:4` contains an unclosed `ARCHIC` node and a stray `weekly · measure-only"]` fragment after `BTEXP`. JSON shape tests pass because they never parse Mermaid.

**Fix:** repair the diagram and add a CI test that invokes the same Mermaid parser/version used by the app. Node-key presence is not render validation.

## Better implementation sequence

1. Pause reliance on Guardian alerts; do not create stops from them.
2. Check in schema reconciliation and close the TRUNCATE hole.
3. Replace snapshot diffing with an account-scoped transition/reconciliation state machine, bootstrap semantics, and idempotent run claims.
4. Separate operational order counts from realized live-lot outcomes; remove the proxy from learning gates.
5. Build the broker tradability shadow and cover every direct submit site; enforce only after reviewed shadow evidence and explicit approval.
6. Repair ZIP revision selection/streaming and USPS semantics.
7. Replace per-SHA IC grouping with continuous monitoring and release annotations.
8. Repair the system map and test actual Mermaid parsing.

## Verification performed

- Full suite: 287 files passed, 1 skipped; 2,524 tests passed, 7 skipped.
- TypeScript: clean.
- Isolated production build: passed, 73 pages; known Supabase Edge runtime warning remains.
- Production schema, grants, RLS, constraints, triggers, and cron inspected.
- Rolled-back ledger UPDATE and DELETE mutation tests fired; zero synthetic residue.
- Independent amortization fixture matched.
- Production evidence: Guardian ledger 0 rows; property ZIP observations 0 rows; non-null live win rates 0; no code-version IC cell reaches the evidence floor.
