# Feature: Daily Per-Holding Risk Analytics

**Status:** SHIPPED — current formula `hr-v3`
**Last updated:** 2026-07-21
**Owner:** Vaibhav
**Update this file when:** the per-holding risk score formula, the strategy-decision
rules, the daily cron cadence, or the snapshot schema changes.

> **Sector-cap breach allocation (`hr-v1` → `hr-v2`, 2026-07-16):** the posture rule
> below ("hard concentration/cluster breach → `trim`") was wrong for the SECTOR cap.
> A sector breach is a property of the sector, not of any name in it, so it gave
> every holding in the sector the identical `trim` with no size. The per-name
> allocator — which names absorb the breach, how much each gives up, and why a name
> was NOT selected — is specified in
> **`features/risk-sector-breach-allocation/FEATURE_ARCHITECTURE.md`**, which is the
> authority for that rule, its NAV denominator, and the read-only advisory labelling.
> This file remains the authority for the score, the cron, the snapshot schema, and
> the LLM prose boundary. No migration; `formula_version` carries the change.

> **Account-intent correction (`hr-v2` → `hr-v3`, 2026-07-21):** a generic Kairos
> trading cap is not an approved sell mandate for a long-term/read-only account.
> Concentration breaches on every live account now produce `review`, never `trim`.
> Broad asset-class sleeves (`Diversified Equity`, `International Equity`, Fixed
> Income, Commodities, Digital Assets) are not equity sectors and are excluded
> from `max_sector_exposure_pct`. Correlation remains measured but produces
> `review` until a deterministic allocator identifies the holding and quantity.
> Having an order path is not proof of an account-specific concentration mandate.
> A future `trim` requires both that mandate and a deterministic executable share-
> quantity plan. Protective-stop/thesis `exit_review` precedence is unchanged. No
> schema or order-path change.
> Stored `hr-v1`/`hr-v2` rows remain immutable audit evidence, but current Risk
> Analytics and newsletter read surfaces expose their original posture separately
> and render legacy `trim` as `review` with an explicit historical-reason label.

## Intent (owner, verbatim)

> **Canonical account labels (2026-07-21):** `broker + account_id` remains the
> stable identity and join key. The latest verified `live_account_snapshots.nickname`
> is presentation metadata only. Live Portfolio and Risk Analytics render
> `<nickname> · <broker> ••••<last4>`; if the nickname is unavailable they render
> `<broker> ••••<last4>`. The read API enriches historical runs at response time,
> so immutable risk evidence is never rewritten when an account is renamed. Full
> account IDs remain authenticated API request keys but are never rendered as
> visible account labels; raw snapshot rows are not returned. Nickname lookup
> failure degrades to the masked fallback without blocking risk results.

> Risk analytics on left panel — add live OTHER accounts, each holding's risk
> analytics, score, and details of risk and what should be our strategy for each
> one of them, updated everyday.

## Decisions (approved 2026-07-11)

- **Strategy source: Hybrid.** A deterministic engine computes the per-holding risk
  score (0–100) AND the risk posture (`hold` | `review` | `trim` |
  `exit_review`). A risk-only engine must **not** recommend adding capital:
  `add` requires a separate current, actionable, deterministic alpha signal plus
  the existing portfolio/execution gates. The risk page may display
  `add_capacity=true` (risk capacity exists), but that is not an add recommendation.
  An LLM writes only the human-readable explanation around that fixed decision —
  it cannot change the score or the action. Complies with PROJECT_DECISIONS
  ("deterministic services calculate risk; LLMs may propose/explain") and the
  safety rule ("LLMs may not control money limits, accounts, promotion, order
  submission").
- **Scope: all live accounts.** Every Robinhood account (Trading `605420660`,
  read-only `965848641`, any others) + Kite India. The strategy line is
  **advisory for all accounts and wired to NOTHING** — it never reaches the order
  path. Only `605420660` can ever act on a call, and only via the existing
  owner-click Execution Gateway.

## Non-goals / guardrails

- No auto-execution. Strategy text is display-only.
- New positions long-only; `exit`/`trim` calls are advisory, not orders.
- Additive migration only; daily snapshots are an append-only history table.
- No cross-currency roll-up. USD and INR accounts are scored and trended
  independently; the feature never adds USD market value to INR market value.
- A score is a **risk-control pressure index**, not a probability of loss and not
  a return forecast. UI copy must not present it as predictive confidence.
- Missing/stale inputs produce `insufficient_data` or a lower
  `data_confidence`; the engine must not replace unavailable beta, correlation,
  sector, quote, or cost-basis evidence with a confident neutral score.
- Unrealized loss alone never creates an `exit_review`. Selling solely because a
  holding is down is a loss-chasing rule. Exit review requires a deterministic
  protective-stop/thesis-break/hard-risk-breach reason with its evidence recorded.
- Read-only accounts stay read-only. Without an approved account-specific
  objective/cap mandate, concentration produces `review`, not a sell instruction.
  A verified protective-stop/thesis break may still produce advisory `exit_review`.

## Data model (additive)

`holding_risk_runs` (append-only, one row per market/account computation):
- `id uuid`, `run_key text unique`, `market`, `currency`, `broker`,
  `account_id`, `account_label`, `status` (`running|complete|failed|partial`)
- `source_captured_at`, `started_at`, `completed_at`, `formula_version`,
  `input_hash`, `data_confidence`, `missing_inputs text[]`, `error`
- `run_key` is deterministic for `market × account × local trading date ×
  formula_version × input_hash`; concurrent/retried crons claim it through a
  unique insert. Do not use check-then-insert idempotency.

`holding_risk_snapshots` (append-only, one row per run × holding):
- `id`, `run_id uuid FK holding_risk_runs(id)`, `captured_on date`,
  `market`, `currency`, `broker`, `source`, `source_captured_at`,
  `account_id`, `account_label`
- `symbol`, `sector`, `qty`, `current_price`, `average_cost`,
  `market_value`, `weight_pct`, `beta`, `realized_vol_pct`,
  `unrealized_pnl_pct`
- `holding_risk_score int`, `risk_label`, `risk_drivers jsonb` (deterministic detail)
- `risk_posture text` (`hold|review|trim|exit_review`),
  `action_reason text` (deterministic), `add_capacity boolean` (never an order signal)
- `data_confidence numeric`, `missing_inputs text[]`, `formula_version text`
- `strategy_note text` (LLM prose, nullable — populated best-effort, never blocks)
- `created_at`

`account_risk_snapshots` (new append-only table, one row per
`holding_risk_runs.id`): the existing in-code `RiskMetrics` roll-up persisted
so the page can show Δ-vs-prior-comparable-run and a trend. This table does **not**
exist today; “existing” refers only to the TypeScript `RiskMetrics` contract.
Store `currency`, `source_captured_at`, `formula_version`,
`data_confidence`, and `missing_inputs` here too.

Schema rules:
- Unique `(run_id, symbol)` for holding rows and unique `run_id` for account
  rows. Tables have INSERT-only service-role policies plus UPDATE/DELETE-blocking
  triggers. Reruns insert a new run only when inputs/formula changed; they never
  upsert or rewrite a prior snapshot.
- Owner-authenticated SELECT only; no anon access. Account identifiers and
  positions are sensitive.
- Numeric checks: finite, `market_value >= 0`, `0 <= weight_pct <= 1`,
  `0 <= score <= 100`, `0 <= data_confidence <= 1`.
- No cascade that can delete snapshot history. A failed run remains as evidence.

## Compute path

1. Add a pure, versioned module `lib/risk/holding-risk.ts` with
   `computeHoldingRisk(holding, ctx)` →
   `{ score, label, drivers[], riskPosture, actionReason, addCapacity,
   dataConfidence, missingInputs }`. Pure function; `ctx`
   carries account/portfolio totals, owner-approved risk limits, sector exposure,
   correlation evidence, beta/volatility, quote freshness, and data availability.
   Do not enlarge `lib/portfolio-risk.ts` further; reuse its types/calculations
   where sound, but keep daily snapshot logic isolated and testable.
   - V1 score is formula-versioned and based on **limit utilization**, not
     uncalibrated “TBD” weights:
     - name concentration: 30 points, scaled against
       `max_name_exposure_pct`;
     - sector concentration contribution: 20 points, scaled against
       `max_sector_exposure_pct`;
     - volatility/beta contribution: 15 points, scaled against the portfolio
       volatility/beta budget, only when real price evidence is available;
     - correlated-cluster contribution: 15 points, from computed aligned-return
       correlations, never the small static `KNOWN_CORR` map alone;
     - drawdown/stop-distance pressure: 10 points; drawdown alone cannot trigger exit;
     - liquidity/event/idiosyncratic flags: 10 points when supported by fresh data.
     Each component is clamped 0–its cap and recorded in `risk_drivers`.
   - If required structural fields (qty, price, market value, account total,
     currency) are missing/non-finite, return `insufficient_data` with no numeric
     score. Optional missing dimensions reduce `data_confidence` and are excluded
     from the numerator without renormalizing the score to appear fully confident.
   - Posture precedence: verified protective-stop/thesis-break →
     `exit_review`; direct-name, allocated real-sector, and correlated-cluster
     concentration produce `review` for every account because global references
     are not account-specific sell mandates; incomplete or
     conflicting evidence → `review`; otherwise `hold`. `add_capacity` means
     only that owner-approved risk limits have room.
2. New cron `POST /api/agents/holding-risk` (cron-secret gated):
   - accept only `market=us|india`; use verified market calendars and the
     market-local completed session date;
   - acquire the append-only run claim before external/LLM work;
   - fetch all live accounts (reuse `fetchRobinhoodBrokerAccounts` / Kite), but
     persist only broker-verified account identities. Today
     `fetchKiteBrokerAccount()` reports placeholder `accountId="kite_india"`;
     it must instead return the verified Kite `user_id` that matches
     `active_account_india`, or the run fails closed for that account;
   - **Robinhood source (shipped 4f0bec7, 2026-07-12):** `fetchRobinhoodBrokerAccounts`
     no longer uses the classic REST client (`api.robinhood.com` 401s
     `rejected client id` for the MCP-scoped vault token — it never returned
     holdings). It now calls `captureAllRobinhoodAccounts()` in
     `lib/robinhood-mcp.ts`: one agentic-MCP session, `get_accounts` enumerates
     all 6 RH accounts, per-account `get_equity_positions` + `get_portfolio`, and
     a batched `get_equity_quotes` over deduped held symbols to price holdings.
     `agentic_allowed=false` gates order placement only, not reads, so all 6
     accounts feed risk while order placement stays restricted to `605420660`.
     The same capture backs `refreshViaMcp()` (all 6 accounts upserted into
     `live_account_snapshots`, not only the active one);
   - capture one coherent, bounded input snapshot per account. Never combine a
     Robinhood account timestamp with another account's holdings or a later quote;
     record source timestamps and reject/mark stale inputs;
   - compute per-holding + per-account risk deterministically,
   - LLM pass (hybrid): given the fixed score+action, write `strategy_note` per
     holding. The prompt contains only structured facts; output is length-bounded,
     schema-validated, and cannot introduce new numbers/actions. Batch notes to
     control cost. Best-effort; empty note on LLM failure never blocks the row.
   - insert snapshots and mark the run complete in one database transaction/RPC.
     Never `upsert` append-only snapshot rows. Partial DB failure marks the run
     failed/partial and does not publish it as latest.
3. Keep `GET /api/portfolio/holdings` unchanged for live view. Add owner-gated
   `GET /api/portfolio/risk-daily?market=us|india&accountId=...` that returns the
   latest **complete** run plus the previous complete run with the same
   account/market/currency/formula version. Do not compare across a formula change.

## UI (PortfolioRiskPage.tsx)

- Holdings table gains columns: **Risk** (score chip, colored) and **Action**
  (hold/review/trim/exit-review pill). `insufficient_data` is shown explicitly,
  not as risk 0.
- Row expander shows `risk_drivers` bullets + `strategy_note` prose + Δ vs
  yesterday.
- Header cadence flips `as-needed` → `daily` with "Last computed: <date>" from the
  snapshot, the source-data as-of time, formula version, and confidence. The live
  Refresh remains separate and must not silently overwrite the daily historical run.
- Account tabs never aggregate currencies. Read-only accounts show
  “advisory only”; the agentic trading account still offers no order button from
  this feature.
- Account tabs use the canonical presentation label above. Never use a transport-
  adapter fallback label or expose a full broker account number in UI copy.

## Cron

`holding-risk` — daily, per market (`?market=us`, `?market=india`), after the
respective exchange close **and after the authoritative account snapshot refresh**.
If the refresh is absent/stale, publish a failed/insufficient-data run, not yesterday's
risk as today's. The route is owner-or-valid-cron-secret gated, concurrent runs are
serialized by the DB run claim, and provider/LLM failures are recorded per account.
Exact times and dependency ordering go in
`docs/arch/05-crons-and-scheduling.md` on ship.

## Failure and safety behavior

- Account enumeration/config/profile error: fail that account closed; do not
  substitute another account or the combined portfolio.
- Stale quote/account snapshot: no actionable posture; `insufficient_data`.
- Missing sector/beta/correlation: lower confidence and list the missing inputs;
  never silently use “Other”, beta 1.0, or zero correlation as verified fact.
- LLM unavailable/invalid: persist deterministic row with null note.
- Snapshot insert/transaction failure: run is failed and is not returned as latest.
- Duplicate cron/retry: unique run claim returns the existing run; no duplicate
  holding rows and no mutation.
- Formula change: new `formula_version`; trends/deltas are not compared across
  versions without an explicit compatibility transform.
- Corporate actions/symbol changes: preserve broker symbol and normalized symbol,
  with the raw broker payload hash/provenance; never infer P&L across a split from
  unadjusted values.

## Required verification before ship

- Pure formula tests at every threshold and with NaN/Infinity/null inputs.
- US and India fixtures proving no currency/account cross-contamination.
- Duplicate/concurrent cron test and transaction rollback test.
- Stale/missing broker snapshot and provider failure tests.
- Kite token user-id mismatch test; unknown Robinhood account remains advisory.
- Append-only trigger tests (UPDATE/DELETE rejected) and owner-only RLS tests.
- LLM output cannot alter score, posture, drivers, symbols, or numbers.
- Clean migration replay, `tsc --noEmit`, full unit suite, build, and authenticated
  Risk page smoke test.

## Cross-doc updates required on ship (same commit)

- `docs/arch/05-crons-and-scheduling.md` — new daily cron.
- `docs/arch/08-risk-and-safety.md` — advisory-only strategy line, read-only scope.
- `docs/arch/04-database-schema.md` — two new tables.
- `public/agent-diagrams/system-map.json` — new HoldingRisk node + history entry.
- Migration verified applied to prod DB before the reading code ships.

## Reviewer changelog (ChatGPT)

- Corrected the append-only/upsert contradiction by adding run-level idempotency,
  insert-only snapshots, immutable triggers, and a publish-only-complete rule.
- Split risk capacity from alpha: removed risk-only `add` recommendations and
  prohibited loss-only exit calls.
- Defined V1 score semantics/components so the implementation is not left to
  arbitrary thresholds; added confidence/abstention for missing data.
- Added market/currency/account/source timestamps and prohibited USD/INR or
  cross-account aggregation.
- Corrected the Kite reuse assumption: current broker code uses the placeholder
  `kite_india`; daily risk must use the broker-verified Kite `user_id`.
- Added coherent source snapshots, stale-data behavior, transactional publication,
  concurrent cron handling, formula versioning, security/RLS, failure modes, and
  acceptance tests.
