# Alpaca Live account integration — architecture and execution plan

**Status:** Owner-approved to implement read-only account visibility and local credential verification. Broker routing, automatic execution, and Guardian automation remain gated on separate proof and owner enablement.

## Problem and goal

The owner has applied for an Alpaca individual brokerage account and has added its live API key pair to local `.env.local`. Kairos already has Alpaca account/order adapters, but the authenticated US Live Portfolio route currently reads Robinhood only; the app does not consistently recognize the owner's explicit `ALPACA_LIVE_API_KEY` / `ALPACA_LIVE_API_SECRET` names. The Vault PIN recovery implementation exists locally, but production still renders only the locked-PIN form.

Goal: recognize the live credentials without exposing them, verify the account using read-only endpoints, show Alpaca Live as a distinct account beside other live broker accounts, and make system/connection failures visible. The actual Live Portfolio page reads `live_account_snapshots` via `app/api/live-portfolio/route.ts`; its producer is `app/api/live-account/refresh-snapshot/route.ts`. The separate holdings/risk API is not the page's account source. Then maintain a prioritized queue for additional broker, Guardian, and market-data work without silently treating an account connection as trading readiness.

## Existing owners to extend

- Credential pair resolution: `lib/brokers/alpaca-credentials.ts` (Vault-first, environment fallback).
- Account and position reads: `lib/brokers/alpaca.ts` (`fetchAlpacaAccount`).
- Broker account type and labels: `lib/brokers/types.ts`, `lib/brokers/account-label.ts`.
- Live Portfolio account snapshots and equity curve: `app/api/live-account/refresh-snapshot/route.ts`, persisted to `live_account_snapshots` / `live_performance`, then read by `app/api/live-portfolio/route.ts`.
- Authenticated live holdings and risk rollup: `app/api/portfolio/holdings/route.ts` (a distinct consumer; update only if the Alpaca account is intentionally included in that risk view).
- Existing read-only account enumeration: `lib/brokers/index.ts`; this does not by itself populate the snapshot-driven Live Portfolio page.
- Guardian: `lib/trading/guardian-protection-monitor.ts`, currently restricted to a specific Robinhood account and its own proposal/execution gates. Do not broaden it as part of account discovery.
- Vault PIN recovery: `app/dashboard/admin/vault/page.tsx`, `app/api/admin/vault/change-pin/route.ts`, and the current architecture contract in `docs/arch/08-risk-and-safety.md`.
- Health alert lifecycle: existing System Health issue reporter and alert taxonomy; do not add a parallel health store.

## Phase 0 — credential recognition and read-only verification (now)

1. Resolve complete paper/live pairs only. For Live, canonical names are `ALPACA_LIVE_API_KEY` and `ALPACA_LIVE_API_SECRET`; retain legacy `ALPACA_API_KEY` and `ALPACA_API_SECRET` compatibility. Keep Vault values authoritative and never fall back across Paper and Live environments.
2. Test the local Live key pair with read-only `GET /v2/account`, `GET /v2/positions`, and configuration reads. Redact account number, key, secret, and exact balances from logs and chat. Do not send any order.
3. Record status, currency, restrictions, shortability, fractionability/asset eligibility as available, and last successful refresh. Do not infer day-trading limits from retired PDT fields.

## Phase 1 — distinct account visibility and operational health

1. Add an independent `fetchAlpacaAccount(false)` snapshot capture to the authenticated/cron-protected `refresh-snapshot` producer; never include `fetchAlpacaAccount(true)` in the live snapshot table. Keep paper and live books separate. The Robinhood MCP/local-source selection must not gate Alpaca's independent capture.
2. Preserve account identity (`broker=alpaca_live`, Alpaca account ID, live environment), source timestamp, status, cash, buying power, equity, positions, and error state in the snapshot/response. Aggregate same-currency NAV only for healthy accounts actually included in the corresponding holdings set; never merge order authority across accounts.
3. Deduplicate or scope holdings by `(broker, account_id, symbol)`, not symbol alone. Robinhood and Alpaca holding the same ticker represent two positions and two distinct books.
4. Emit deduplicated System Health issues for configured credentials that fail authentication, blocked/restricted accounts, stale snapshots during expected operation, and repeated provider failures. Resolve only after a successful authenticated refresh and account-state check. The health reporter's own write failure must reach independent deployment monitoring/logs.
5. Show connection source, environment, account label, last refresh, and any restriction/error in Live Portfolio/Settings without returning credentials. A failed fetch must preserve the last successful snapshot and raise a deduplicated System Health issue; only a later healthy capture resolves it.

## Phase 2 — Alpaca order-routing readiness (not implicitly enabled)

1. Keep the existing Alpaca broker adapter and per-symbol `getAlpacaAsset` preflight. Verify order routes persist broker and account identity through proposal, submission, sync, and fill reconciliation.
2. Require explicit account selection and broker-specific buying-power/risk checks. A combined portfolio view is display/risk aggregation only; it is not permission to route orders to a different account.
3. Validate paper order lifecycle first: acknowledgement, partial/full fill, reject, cancel/replace, restart recovery, fractional quantities, and account reconciliation. Do not submit a live order as a test.
4. Live execution remains behind the existing owner live switch and all safety controls. Merely adding credentials must never activate it or make Alpaca the default live broker.

## Phase 3 — Guardian and protective orders (separate readiness gate)

1. Do not reuse the Robinhood-only Guardian plan identity or assume the current software-stop watcher covers Alpaca.
2. Add broker/account-scoped position detection and protection records only after schema/design review. Prefer broker-native bracket/OCO protection where supported, but reconcile child orders, partial fills, cancel/replace, corporate actions, and remaining quantity before displaying “protected.”
3. Test the complete lifecycle in Alpaca Paper, including ambiguous network responses and restart/reconciliation. Do not test with the live account and do not enable unattended actions.

## Phase 4 — Alpaca market-data provider (separate from account approval)

1. Add Alpaca to the existing US data-provider abstraction for timestamped quotes and intraday bars; do not add another shadow program.
2. Query the usable feed/entitlement safely and make venue/feed provenance explicit. Brokerage approval does not imply consolidated SIP access. A free IEX feed has different coverage and subscription limits from a consolidated feed.
3. Prioritize held symbols and the ranked research shortlist under the actual subscription cap. Use gap detection/backfill and stale/spread gates. Keep fundamentals on their current providers; Alpaca price data is not a fundamental-data replacement.
4. Do not use an Alpaca quote as the execution quote for Robinhood or another broker. Execution preflight remains broker-specific.

## Vault recovery release requirements

- Keep the PIN-recovery link visible on the locked Vault screen without requiring the forgotten PIN.
- Only the authenticated, confirmed owner may request a one-time code; the destination is fixed to the canonical owner email, never client-supplied.
- Change the stored salted PIN hash only after OTP verification; do not modify API keys.
- Ensure the deployed Supabase Auth email template includes the OTP token required by the code-entry flow; verify the setting without exposing OTPs.
- Verify on the deployed site that the control is visible, then request an email only when the owner chooses it. A production route test must not send unsolicited mail.

## Prioritized queue

| Priority | Work | Gate |
|---|---|---|
| P0 | Recognize the current Live env names; read-only account verification; add Alpaca Live to the live account rollup; repair and release the locked Vault recovery UI | No secrets logged; no orders; account identity and health visible; recovery control appears on production |
| P1 | Move Live credentials into production Vault or Vercel secret storage through the owner's protected path; add account-status/capability surface and alerts | Production read-only auth succeeds; no local-only env assumption; no credentials returned to browser |
| P1 | Alpaca Paper order lifecycle and account-scoped reconciliation | Complete paper lifecycle passes; live routing remains off |
| P2 | Alpaca Guardian/protective-order lifecycle | Broker-native protection/reconciliation proven in Paper, including partial fills and cancels |
| P2 | Alpaca intraday US research data integration | Entitlement, feed freshness, gaps, venue provenance, and System Health verified; no shadow table or score-weight change |
| P3 | Decide whether Alpaca becomes a selectable/default live execution broker and separately whether to enable any automated live action | Explicit owner decision after readiness evidence |

## Acceptance criteria and tests

- Credential unit tests cover canonical Live names, legacy alias, Vault precedence, empty rows, incomplete pairs, and strict Paper/Live separation.
- Account tests cover inactive/blocked states, errors, stale refresh, no credential leakage, and missing account IDs.
- Snapshot-producer and portfolio tests prove Alpaca Live appears after refresh, Alpaca Paper does not, same symbols in different brokers remain separate, errored accounts preserve prior snapshots and do not dilute NAV, and unauthenticated users receive no account data.
- Vault recovery tests prove the locked state exposes “Forgot PIN?”, the destination cannot be changed by request input, unauthenticated/unconfirmed sessions fail closed, invalid/expired OTP leaves the old hash intact, and successful OTP verifies the new PIN.
- End-to-end read-only account test confirms the expected account status and positions without logging secrets, account numbers, or exact balances.
- Typecheck, focused tests, full test suite, production build, secret scan, deployment readiness, and a final browser check of the production Vault page are required before calling the recovery link fixed in production.

## Explicit non-goals

- No live trade, paper order, or API-key transmission to a third party.
- No change to live enablement, default broker, sizing, score, target, stop, capital rotation, or portfolio limits.
- No use of Alpaca market data to certify Robinhood/other-broker execution or Guardian protection.
- No modification to India broker/data paths.
