# Full-System Deep Audit — Kairos

**Reviewed by Codex / GPT-5 on 2026-07-10.** This is a repository-grounded review of the checked-out tree. Documentation and work-log claims were treated as hypotheses, not evidence.

## 1. Executive verdict

1. **Kairos is not yet safe to enable for autonomous live money.** A real autonomous submit path exists, but it bypasses the hardened manual Execution Gateway and directly invokes the Robinhood and Kite clients (`lib/trading/autonomous-live.ts:329-356`). Consequently the autonomous path omits account allowlisting, the real kill-switch engine, G1 decision-quality, G3 portfolio construction, fresh-price drift, held-position checks, broker preview, and broker-specific enablement enforced by `app/api/broker/orders/route.ts:130-290`.
2. **A clean database cannot reproduce the live-auto application.** Code calls `reserve_live_order_budget_v2` and writes `broker_order_events` (`lib/trading/autonomous-live.ts:296-377`), while migrations 139 and 140 do not exist in `supabase/migrations`; migration 141 merely says they were applied out of band (`supabase/migrations/141_live_auto_per_market_mode.sql:1-14`). This is a release blocker.
3. **India autonomous sizing is dimensionally invalid.** It uses the fixed Robinhood USD account snapshot for both markets (`lib/trading/autonomous-live.ts:15,111-120`), feeds INR prices into that USD NAV, and clamps both markets with the USD-named per-order cap (`lib/trading/execution-kernel.ts:211-230`). India can be vastly under- or over-sized.
4. **The enabled-autonomy trace currently dead-ends before signal evaluation.** The query selects `agent_signals.evidence_confidence` (`lib/trading/autonomous-live.ts:162-171`), but migration 136 adds that column only to `decision_observations`, not `agent_signals` (`supabase/migrations/136_scoring_p0_schema.sql:24-47`), and the research signal insert does not persist it (`lib/research-agent.ts:1186-1210`). The PostgREST error is ignored, so the loop silently processes zero signals.
5. **The weight-learning loop is partly real, not wholly theater.** Owner-promoted champion weights are consumed on the next research run (`lib/research-agent.ts:961-1037`), and a promoted genome changes paper entry threshold, sizing, stops/targets, and time exits (`lib/research-agent.ts:1040-1049`, `app/api/agents/paper-trade/route.ts:258-395`, `app/api/agents/position-monitor/route.ts:103-213`). However, the Learner proposes from global `signal_weights`, not the market champion, and does not renormalize the five-weight vector (`app/api/agents/learner/route.ts:468-515`).
6. **Feature Registry and Edge Lab remain research telemetry.** Active registry features are evaluated and logged but explicitly never added to the score (`lib/research-agent.ts:1293-1319`). Edge IC writes only `edge_*` state and uses a static/current universe with any-horizon-wins selection (`lib/edges/ic.ts:98-173`). Neither mechanism evolves live selection.
7. **The advertised validation gate has an owner override and a statistical leakage defect.** `force_unvalidated:true` permits promotion without a passed experiment (`app/api/strategies/versions/route.ts:55-89`), while the calibration model is fit on the entire dataset before its “out-of-sample” fold predictions (`lib/validation/calibration.ts:78-103`). Owner override is acceptable governance only if the UI makes it exceptional; calling the model OOS is factually wrong.
8. **API and RLS defense-in-depth is incomplete.** Several public routes expose personal rows or burn provider quotas, and many authenticated RLS policies remain `USING(true)` outside migration 142. Direct Supabase clients bypass Next middleware. The vault stores API keys and the PIN as plaintext values (`supabase/migrations/011_api_key_vault.sql:1-18`, `app/api/admin/vault/route.ts:27,95-117`).
9. **Operational scheduling is fragmented and not market-correct for autonomous India.** Most agents rely on one Windows machine (`scripts/register-tasks.ps1:21-47`); Vercel runs autonomous-live once at 14:00 UTC (`vercel.json:20-23`), which is after the NSE close. A market order cannot reliably execute for India at that schedule.
10. **This is a promising governed research/paper platform, not “the best self-evolving trading agent” yet.** The deterministic scoring and append-oriented evidence work are good foundations. The missing pieces are one shared live-money gateway, reproducible schema, statistically honest promotion, real market-specific calibration, and explicitly connected feature/factor lifecycle—not more agents or parameters.

## 2. Ranked findings table

| Rank | Severity | Area | Finding | `file:line` evidence | Concrete fix |
|---:|---|---|---|---|---|
| 1 | CRITICAL | Money / schema | Live-auto depends on out-of-band migrations 139/140. A new environment lacks its columns, event ledger, status constraint, and `reserve_live_order_budget_v2`; code cannot run safely or reproducibly. | `lib/trading/autonomous-live.ts:54-65,191-209,296-377`; `supabase/migrations/141_live_auto_per_market_mode.sql:1-14`; `docs/arch/04-database-schema.md:768-769` | Add immutable, idempotent migration files containing the exact production 139/140 DDL/RPC. Verify hashes against production, then run a clean Supabase reset and integration test before enabling the deployment flag. Do not invent a second implementation. |
| 2 | CRITICAL | Money / architecture | Autonomous live bypasses the sole hardened Execution Gateway and submits directly to broker clients. It omits account allowlist, `checkKillSwitches`, G1, G3, quote-drift, preview/review, Robinhood enable flag, and held SELL checks. | `lib/trading/autonomous-live.ts:329-356`; compare `app/api/broker/orders/route.ts:130-290` | Extract a single server-only `executeApprovedOrder()` service used by manual and autonomous callers. Pass an actor envelope (`owner` or `autonomous_worker`) and prohibit autonomous overrides. The service must enforce the identical broker/account/kill/quality/portfolio/quote/notional/idempotency checks before its only broker-write call. |
| 3 | CRITICAL | Money / India | India auto sizing uses Robinhood account 605420660’s USD NAV, INR quote, and USD per-order cap. The quantity has no coherent currency unit. | `lib/trading/autonomous-live.ts:15,111-120,177-189,264-282`; `lib/trading/execution-kernel.ts:211-230` | Resolve NAV per `(market, broker, account, currency)`. US must use fresh USD Robinhood equity; India must use fresh INR Kite equity/cash. Rename policy fields to currency-neutral input or supply `max_per_order_notional` with explicit currency. Reject any mismatch. |
| 4 | CRITICAL | Autonomy | Signal query requests a nonexistent `agent_signals.evidence_confidence`; the query error is discarded, yielding zero orders with no diagnostic. | `lib/trading/autonomous-live.ts:162-176`; `supabase/migrations/136_scoring_p0_schema.sql:24-47`; `lib/research-agent.ts:1186-1210` | Do not duplicate confidence blindly. Join `signal_id` to `decision_observations`/`v_decision_quality`, require the matching scoring version and market, and treat query errors as a failed run with a critical alert. Add an integration test proving one eligible signal reaches reservation in dry-run. |
| 5 | CRITICAL | Money / risk | Autonomous live checks configuration booleans but never invokes the actual drawdown/daily-loss/accuracy kill-switch computation. A stale `trading_enabled=true` can submit despite a newly breached limit. | `lib/trading/autonomous-live.ts:70-90`; real check at `app/api/broker/orders/route.ts:165-169`; `lib/kill-switches.ts:31-176` | Invoke `checkKillSwitches(svc, market)` inside the shared execution service immediately before reservation and again before broker submit if the quote/preview phase is long. Fail closed and emit an audit event. |
| 6 | CRITICAL | Money / lifecycle | Auto BUY exists without an autonomous protective-exit/cancel/reconcile control plane. The paper `PositionMonitor` does not manage live broker positions. | `lib/trading/autonomous-live.ts:191-356`; `lib/trading/execution-kernel.ts:61-69`; paper-only exits at `app/api/agents/position-monitor/route.ts:205-313` | Keep auto BUY disabled until live order reconciliation, partial-fill accounting, broker-native protective orders/GTT, cancel handling, and a live position monitor are implemented and soak-tested. Exits may be deterministic and autonomous but must be bounded, held-only, idempotent, and journaled. |
| 7 | HIGH | Money / concurrency | A signal is not atomically claimed. Concurrent/repeated cron runs can create different proposals for the same signal; the unique broker-order guard is proposal-scoped, so both may reserve and buy. | `lib/trading/autonomous-live.ts:159-209,296-317`; proposal-scoped check in `app/api/broker/orders/route.ts:89-94` | Add an additive unique partial index for active autonomous proposals on `(signal_id, market, execution_mode)` and an atomic claim RPC. Generate a deterministic client order key from signal+market+policy version and require broker/client idempotency. |
| 8 | HIGH | Money / positions | `openPositions` counts every historical `broker_orders.status='filled'`, not current net open positions, and is unscoped by market/account. It will eventually permanently trip the cap. | `lib/trading/autonomous-live.ts:145-150,248-249` | Maintain/reconcile a broker-position snapshot or compute signed filled quantities minus sells per account+market+symbol. Count positive net positions only, with freshness bound; fail closed when the snapshot is missing. |
| 9 | HIGH | Money / fail-open | A null lease is accepted, and missing per-market `trading_enabled_*` is accepted because only strict `false` blocks. These are unsafe compatibility fallbacks on a live-money path. | `lib/trading/autonomous-live.ts:78-90`; `lib/trading/execution-kernel.ts:51-59` | Require `live_auto_enabled_until` to be a valid future timestamp and each selected market flag to equal `true`. Eliminate pre-migration compatibility from live code after migrations are verified. |
| 10 | HIGH | Money / broker | Robinhood auto submission calls an unofficial direct REST endpoint with an MCP token and no MCP `review_equity_order`/preview, while the product architecture claims MCP. Broker rejection vs ambiguous acceptance is not robustly distinguished. | `lib/brokers/robinhood/rest-client.ts:8-86`; `lib/trading/autonomous-live.ts:347-365` | Use the supported authenticated Robinhood MCP adapter and deterministic `callTool`, with review result validation and pinned account. If direct REST is officially required, use a separately documented credential and implement idempotency/status lookup. Never retry an ambiguous submit until reconciliation proves absence. |
| 11 | HIGH | Money / durability | After broker submission, database update, immutable event insert, proposal update, and run journal errors are ignored. Real money can move without durable local truth. Clean broker rejections are also recorded as `unknown_needs_reconcile`, permanently reserving budget. | `lib/trading/autonomous-live.ts:358-416` | Check every persistence result. If the broker may have accepted, transition to reconcile-needed and emit an out-of-band critical alert. If the broker definitively rejected, record `rejected` and release reservation via an append-only compensating event/RPC. Never rewrite the ledger silently. |
| 12 | HIGH | Scheduling | The only autonomous-live cron is 14:00 UTC for both markets, after India’s close; US timing shifts with DST and is not market-calendar aware. | `vercel.json:20-23`; India schedules acknowledge post-close at `scripts/register-tasks.ps1:26-35` | Create separate US and India entrypoints/schedules guarded by exchange calendar and session window. Use broker clock/exchange calendar, not weekday alone. For market orders, reject outside configured session rather than queue unexpectedly. |
| 13 | HIGH | Learning | Learner starts a market-specific challenger from global `signal_weights`, not that market’s champion, then changes one weight without renormalizing. The proposed vector can be the wrong baseline and sum to more/less than 1. | `app/api/agents/learner/route.ts:468-515`; consumer at `lib/research-agent.ts:991-1037` | Load the selected market champion first; hydrate its validated five-dimensional snapshot, alter one coordinate, project the entire vector onto bounded simplex sum=1, and persist parent hash. Reject missing/invalid champions rather than falling back to global state. |
| 14 | HIGH | Statistical validity | Calibration is fit once on all rows, then the same full-data coefficients generate fold “OOS” predictions. Test outcomes influenced coefficients and standardization. | `lib/validation/calibration.ts:78-103` | Fit scaler and logistic coefficients independently on each fold’s training partition; predict only that fold’s test partition. After honest OOS diagnostics pass, refit once on all eligible history for deployment and label that artifact in-sample refit. Add regularization and market/setup separation. |
| 15 | HIGH | Governance | Champion promotion explicitly accepts `force_unvalidated:true`; schema-compatibility logic can also skip the validation gate, and a market-scoped demote error triggers an unscoped demotion of every champion. | `app/api/strategies/versions/route.ts:55-100` | Remove schema-compatibility fallbacks after migration enforcement. If an owner emergency override remains, require typed reason, step-up auth, explicit UI warning, and mark the version `manual_override`/paper-only—not live-approved. Perform demote+promote in one transaction RPC with a per-market unique champion constraint. |
| 16 | HIGH | Security / API | Public service-role routes expose personal signals/proposals or burn metered APIs. The most serious read leak is Smart Money; public quote/options/chart routes can exhaust quotas. | `app/api/markets/smart-money/route.ts:28-49`; `app/api/options/chain/route.ts:5-20`; `app/api/charts/symbol-overview/route.ts:4-22`; `app/api/social/sentiment/route.ts:7-20` | Require `requireOwner()` for all personal and metered endpoints. If public data must remain public, place it behind strict IP/user rate limits, bounded symbol validation, cache, and no service-role personal-table reads. |
| 17 | HIGH | Security / RLS | Migration 142 fixes only eight tables. Other authenticated policies still use `USING(true)` for strategy/evidence/order events/embeddings and cache/history tables. Any authenticated Supabase user can call PostgREST directly, bypassing Next middleware. | `supabase/migrations/044_rls_enable.sql:7-39`; `supabase/migrations/045_trade_decision_embeddings.sql:22-26`; partial fix `supabase/migrations/142_scope_auth_read_policies_to_owner.sql:8-23` | Inventory every public table; revoke anon/authenticated by default. Add owner-email policies only for client-read tables; make internal/ledger tables service-role-only. Add SQL policy tests using anon, non-owner authenticated, owner, and service-role JWTs. |
| 18 | HIGH | Security / secrets | The “vault” stores API keys and broker tokens plaintext; the admin PIN is also plaintext. RLS is access control, not encryption at rest. | `supabase/migrations/011_api_key_vault.sql:1-18`; `app/api/admin/vault/route.ts:27,95-117`; `lib/kite.ts:14-19,60-65` | Move secrets to Supabase Vault/KMS or application envelope encryption with a deployment key. Store only a salted password hash for PIN verification, add rate-limit/lockout, rotate the exposed legacy cron secret, and never return secret columns through PostgREST. |
| 19 | HIGH | Scoring / provenance | Paper and trader eligibility use a negative filter that admits null or any unknown `score_source`; research also retries an insert after deleting market/source/version columns. Migration drift therefore fails open into actionable untagged signals. | `app/api/agents/paper-trade/route.ts:145-151`; `app/api/agents/trader/route.ts:158-164`; `lib/research-agent.ts:1211-1224` | Positive-allowlist exactly versioned deterministic sources whose strategy version is approved for that pathway. Remove column-deletion fallbacks. Treat any schema mismatch as run failure and alert. |
| 20 | HIGH | Scoring / LLM boundary | New-entry direction is mechanical, but held-position exit is still triggered directly by `thesis.direction === 'short'`; an LLM output therefore changes a decision. Parse failure also suppresses an otherwise mechanical entry. | `lib/research-agent.ts:1125-1144` | Parse the LLM into bounded advisory fields (`veto`, rationale, cited risks). Generate both entry and exit direction deterministically from score/position/exit policy. Define whether parse failure means deterministic continuation or explicit abstain, and test it; do not describe the LLM as “never direction” meanwhile. |
| 21 | HIGH | Labels | Label maturity approximates trading days by calendar time, then chooses the first candle on/after decision date when `price_at_decision` is missing. A post-close/holiday decision can use a future entry close and shift the horizon; market calendars are absent. | `app/api/agents/label-maturation/route.ts:12-20,54-95` | Require an immutable executable `price_at_decision` with timestamp/source, or define next-session-open labeling explicitly. Use US/NSE exchange calendars and count actual sessions. Store entry candle timestamp and benchmark timestamp in each label for audit. |
| 22 | MED | Evidence confidence | `evidence_confidence` is count of included dimensions divided by the number of applicable dimensions, not the promised structural-weight coverage. A missing 40% dimension and missing 10% dimension look identical. | `lib/research-agent.ts:1343-1374` | Compute `sum(base_weight[d] for present, non-degraded applicable d) / sum(base_weight[d] for all applicable d)`. Persist the base-vector hash and degraded set. Never use post-renormalized weights in the denominator. |
| 23 | MED | Statistical validity | Edge IC is vulnerable to survivorship and horizon shopping: it receives a current/static symbol set, samples every fifth date, uses a minimum cross-section of five, and marks an edge eligible if any horizon passes. | `lib/edges/ic.ts:98-173`; `lib/edges/universe.ts:1-74` | Use dated universe membership and delisting-aware data. Require a predeclared primary horizon, correct for edge×horizon multiple testing, raise breadth/history minima, and report turnover/cost-adjusted, benchmark/sector-neutral IC. Keep measure-only until these pass. |
| 24 | MED | Statistical validity | Newey-West lag is the raw horizon even though observations are sampled every five dates, overstating the autocorrelation lag and making results incomparable across sampling frequency. | `lib/edges/ic.ts:118-120,159-168` | Use overlap lag `ceil(horizon / sampling_step)-1` (or stop subsampling and use horizon−1), document units, and validate against a known statistical library fixture. |
| 25 | MED | Learning | Correlation weight credit assignment is univariate, uses only N≥10, and calls absolute correlation “confidence”; correlated features, regimes, selection effects, and repeated tests can produce noise challengers. | `app/api/agents/learner/route.ts:440-466` | Keep it hypothesis-generation only. Use regularized multivariate walk-forward estimates over the broad decision ledger, regime/setup stratification, minimum effective N, stability across folds, and false-discovery control before a challenger can enter paper competition. |
| 26 | MED | Feature evolution | Feature Registry lifecycle can automatically mark a feature active, but “active” is only logged into observation features and never affects scoring. This is correctly safe but mislabeled as evolution. | `app/api/validation/feature-check/route.ts:28-76`; `lib/research-agent.ts:1293-1319` | Rename state to `research_validated` until it is compiled into a versioned shadow policy. Add explicit stages: proposed → validated_measure → shadow → paper_challenger → owner-approved champion. Never let activation directly alter money behavior. |
| 27 | MED | Autonomy sizing | Kelly statistics mix US and India trades, use only ten observations, and fall back to flat position sizing when calibration is absent. This contradicts evidence-bound autonomous sizing. | `lib/trading/autonomous-live.ts:122-143`; `lib/trading/execution-kernel.ts:184-230` | Filter by market, setup, horizon, and strategy version. Require a calibrated artifact with minimum effective sample and freshness; unknown edge must size to zero in autonomous live. Flat sizing may remain for paper/manual owner orders only. |
| 28 | MED | Scheduling / reliability | Core research, paper/trader, learner, labels, monitor, and backup depend on Windows Task Scheduler on one PC; Vercel only owns four crons. Machine sleep/offline creates silent evidence holes. | `scripts/register-tasks.ps1:21-47,76-113`; `vercel.json:7-24` | Move production-critical schedules to one managed scheduler with per-market calendar, distributed lock, retry/backoff, and durable run heartbeat. Keep Windows tasks only as development fallback, not a second active scheduler. |
| 29 | MED | Past-trade behavior | CSV ingestion splits on commas without a CSV parser, uses a simplistic SHR→BUY rule, and lacks a stable broker transaction/lot identity; quoted fields and partial fills can corrupt behavioral episodes. | `app/api/live-portfolio/import-csv/route.ts:13-58,80-156` | Use a real RFC 4180 parser, map transaction types explicitly, preserve original row hash/account/order/activity IDs, and aggregate fills into episodes without deleting raw imports. Make owner gate explicit with `requireOwner()`. |
| 30 | MED | Past-trade labels | Enrichment searches forward/backward calendar dates and mixes adjusted historical closes with raw execution prices; hardcoded regime chronology cannot support causal behavioral conclusions. | `app/api/live-portfolio/enrich/route.ts:7-61,112-142` | Use exchange sessions, corporate-action-consistent prices, explicit as-of macro vintages, and immutable enrichment versions. Recompute into append-only derived rows rather than mutating the source decision. |
| 31 | MED | Route auth | Mentor routes trust `getSession()` server-side instead of validated `getUser()`/owner gate. Several `getUser()` routes prove authentication but not owner locally and rely on middleware behavior. | `app/api/mentor/evaluate/route.ts:20-31`; `app/api/mentor/journal/route.ts:13-21`; `app/api/mentor/scores/route.ts:10-17`; middleware mismatch at `lib/auth/require-owner.ts:5-8` vs `middleware.ts:25-37,65-66` | Replace with `requireOwner()` everywhere personal data, mutation, LLM cost, or provider quota is involved. Keep middleware as UX/defense-in-depth, never the sole API authorization. |
| 32 | MED | Universe / RLS | New universe snapshot tables have no RLS or grants in their migration, and “append-only by convention” has no trigger. | `supabase/migrations/137_universe_snapshots.sql:6-37` | Enable RLS, grant service-role only (or owner-scoped SELECT), and add an UPDATE/DELETE blocker if snapshots are evidence. Add FK only where compatible with ledger retention. |
| 33 | LOW | Scoring | Thin-evidence gate is correctly `<2`, but when exactly one dimension is included the scorer retains its base weight rather than renormalizing; the score is meaningless though later abstained. | `lib/scoring/weighted-score.ts:33-62` | Return an explicit `score:null`/abstain result for fewer than two dimensions so downstream/log consumers cannot mistake the low partial number for a real score. |
| 34 | LOW | Secrets / history | A historical migration contains a literal cron secret even though a later migration unschedules it. Repository history still exposes it. | `supabase/migrations/022_research_cron.sql:10,25,58`; `supabase/migrations/052_unschedule_legacy_pg_cron.sql:1-8` | Rotate the secret if not already rotated; redact it from deployable migration text with a repair migration. Treat history as compromised—rewriting Git alone is not rotation. |

## 3. Dead / mislabeled / duplicate code

| Item | Real status | Evidence | Required correction |
|---|---|---|---|
| Legacy `/api/agents/trade`, `/approve`, `/reject` | Safely inert; always HTTP 410. | `app/api/agents/trade/route.ts:3-18`; `app/api/agents/trade/approve/route.ts:3-12`; `app/api/agents/trade/reject/route.ts:3-11` | Keep until clients are confirmed migrated, then remove routes while retaining historical ledger rows. |
| Feature Registry “active” features | Active means evaluated/logged, not scored. | `app/api/validation/feature-check/route.ts:28-76`; `lib/research-agent.ts:1293-1319` | Rename/document as research-validated; build versioned shadow consumption before calling it evolution. |
| Edge IC “PIT universe” / survivorship removed | False. IC receives the configured current/static list; universe snapshots only record each current run. | `lib/edges/ic.ts:98-113`; `lib/edges/universe.ts:1-74`; `supabase/migrations/137_universe_snapshots.sql:6-14` | Add historical membership/delistings and as-of provider records. |
| Calibration “out of sample” | False; full-data coefficients predict every fold. | `lib/validation/calibration.ts:78-103` | Fit inside each training fold. |
| Live-auto “same hardened gateway” | False; direct broker clients. | `lib/trading/autonomous-live.ts:329-356`; `app/api/broker/orders/route.ts:130-290` | One shared execution service. |
| Migration 139/140 “applied and reproducible” | Applied out of band according to docs; absent on disk. | `WORK_LOG.md:41`; `docs/arch/04-database-schema.md:768-769`; `supabase/migrations/141_live_auto_per_market_mode.sql:1-14` | Restore exact SQL and clean-reset test. |
| `lib/autonomy.ts` comments saying autonomy is always false/no code path | Stale. Flag is now environment-driven and auto submit code exists. | `lib/autonomy.ts:8-14,29-32,55-63`; `lib/trading/autonomous-live.ts:329-356` | Update comments only after architecture is fixed; keep deployment flag false meanwhile. |
| Next ResearchAgent vs Deno Supabase ResearchAgent | Next path is scheduled by current Windows/Vercel scripts; Deno copy has no current scheduler proven and risks drift if deployed. | `scripts/register-tasks.ps1:21-47`; `scripts/run-agents.ps1:21-73`; `supabase/functions/research-agent/index.ts:1-40` | Declare Deno functions retired or generate them from shared packages; do not operate two independent scorers. |
| Old pg_cron with literal secret | Explicitly unscheduled, but still a deployable historical artifact and secret exposure. | `supabase/migrations/022_research_cron.sql:44-61`; `supabase/migrations/052_unschedule_legacy_pg_cron.sql:1-8` | Rotate/redact and verify production `cron.job`. |
| `trade_queue` | No active route writes it; retained for history. | `app/api/agents/trade/route.ts:5-13` | Mark archived/read-only in schema docs and remove broad RLS. |
| Archetypes | Six fixed reweightings in shadow; not learned setup models. | `lib/scoring/archetypes.ts:28-146`; insertion at `lib/research-agent.ts:1435-1484` | Keep shadow and label honestly; promote only after setup-specific OOS evidence. |

What actually runs is split across two schedulers: Vercel runs P1-gate, DB cleanup, autonomous-shadow, and autonomous-live (`vercel.json:7-24`); Windows Task Scheduler runs most research/learning/paper/monitor/briefing/sync jobs (`scripts/register-tasks.ps1:21-47,64-113`). The Deno functions under `supabase/functions/*` may exist in a deployed Supabase project, but no active repository scheduler was found that invokes most of them. Production Supabase scheduler state must be queried before deleting anything.

## 4. Security matrix

### Route matrix

| Route/group | Auth observed | Risk / verdict |
|---|---|---|
| Live order routes: `/api/broker/orders`, `/api/kite/order` | `requireOwner()` (`app/api/broker/orders/route.ts:60-65`; `app/api/kite/order/route.ts:20-23`) | Strong manual owner gate. Autonomous cron is separately secret-gated but bypasses their controls. |
| Cron groups: research, paper-trade, position-monitor, learner, labels, edge jobs, evaluation, sync | `verifyCronSecret` or equivalent owner-or-cron checks in route | Generally correct. Verify every deployed scheduler supplies the current secret and use timing-safe shared helper consistently. |
| Retired trade routes | No auth; always 410 | Safe/inert. |
| `/api/kite/callback` | Signed, short-lived OAuth cookie; no user session by design (`app/api/kite/callback/route.ts:9-29`) | Appropriate callback pattern, assuming cookie is single-use and HMAC key is strong. Check token-store errors; route currently ignores the result at `:43`. |
| Mentor evaluate/journal/scores | `getSession()` (`app/api/mentor/evaluate/route.ts:20-31`, `mentor/journal/route.ts:13-21`, `mentor/scores/route.ts:10-17`) | Replace with `requireOwner`; server-side session data is not sufficient authorization. |
| Import CSV | `getUser()` only (`app/api/live-portfolio/import-csv/route.ts:77-85`) | Personal-data mutation should use `requireOwner`; middleware is not the contract. |
| Smart Money | None; service-role personal-table reads (`app/api/markets/smart-money/route.ts:28-49`) | HIGH data leak. Owner-gate. |
| Theme Scout GET | POST cron is protected, but GET returns service-role theme/watchlist data without owner check (`app/api/agents/theme-scout/route.ts:15-27,161-171`) | Owner-gate GET. |
| Public provider endpoints: social sentiment, options chain/signal, chart overview/history/peers/sectors, market overview/quotes/breadth/insiders, earnings | No route auth; examples `app/api/social/sentiment/route.ts:7-20`, `app/api/options/chain/route.ts:5-20`, `app/api/charts/symbol-history/route.ts:51-78` | Mostly public market data, but they expose paid/free quota and some use service client caches. Owner-gate for this single-user app or add strict rate limits/cache/input bounds. |
| Portfolio/agent/settings routes using `getUser()` | Authenticated, owner enforcement relies on global middleware (`middleware.ts:25-37,65-66`) | Functional today but fragile defense-in-depth. Convert personal/mutating/costly APIs to `requireOwner`. |
| `/api/alerts/stale-check` | Inline timing-safe cron secret in current code (`app/api/alerts/stale-check/route.ts:183-198`) | Protected; scanner false-positive. Move to shared helper to prevent drift. |
| `/api/agents/autonomous-shadow/cron` | Inline timing-safe cron secret (`app/api/agents/autonomous-shadow/cron/route.ts:9-19`) | Protected. Shared helper recommended. |

### Table / RPC matrix

| Table/RPC | Current policy evidence | Risk / fix |
|---|---|---|
| `api_key_vault`, `app_settings` | Plaintext values; service-oriented access (`supabase/migrations/011_api_key_vault.sql:1-18`; `app/api/admin/vault/route.ts:27,95-117`) | Encrypt secrets, hash PIN, revoke all client roles. |
| Eight owner-scoped tables | Migration 142 scopes decision journal, deep analyses, mentor insights, strategy config, decisions, proposals, uploads, paper trades (`supabase/migrations/142_scope_auth_read_policies_to_owner.sql:8-23`) | Good targeted repair, incomplete inventory. |
| `paper_order_events`, `evidence_records`, `corporate_actions`, `strategy_versions`, `experiment_runs` | Authenticated `USING(true)` (`supabase/migrations/044_rls_enable.sql:7-29`) | Any authenticated direct client can read. Owner-scope or service-only. |
| `trade_decision_embeddings` | Authenticated `USING(true)` (`supabase/migrations/045_trade_decision_embeddings.sql:22-26`) | Leaks derived personal trade history. Owner-scope/service-only. |
| Semantic-search RPCs | Latest migration changes to SECURITY INVOKER and fixed search path, but grants authenticated (`supabase/migrations/047_rag_rpc_hardening.sql:10-67`) | Search is bounded and no longer definer bypass; safety still inherits overly broad table RLS. Fix policies or grant owner/service only. |
| `universe_snapshots`, `universe_snapshot_scores` | No RLS statements (`supabase/migrations/137_universe_snapshots.sql:6-37`) | Enable RLS and make evidence append-only. |
| `broker_order_events` and live-auto RPC | Claimed but migration absent | Cannot audit definitive production policy/function body from repo. Restore exact migration before use. |
| Service-role server clients | Used broadly in routes | Correct only after route authorization; a missing auth check becomes full DB bypass. This amplifies every public-route defect. |

Security headers are also below a live-finance bar: the repository does not establish a strict CSP in `next.config.ts:1-40`. Add CSP, frame-ancestors, nosniff, referrer policy, and permissions policy after testing OAuth and charts.

## 5. Money-path integrity

### Manual path

The manual US/combined gateway is the strongest part of the system. It requires owner and request-origin guard (`app/api/broker/orders/route.ts:60-68`), approved/unexpired proposal (`:75-87`), duplicate active-order check (`:89-94`), valid symbol/integer quantity (`:123-126`), configured active broker (`:130-137`), autonomy/trading/broker enablement (`:140-163`), fresh kill switch (`:165-169`), G1 decision quality (`:171-185`), account allowlist (`:190-191`), fresh quote and currency-specific cap (`:193-240`), portfolio gate (`:242-259`), held SELL (`:262-276`), drift/preview checks and atomic reservation later in the same route. The primary defect is duplication: these guarantees are not shared with auto.

The dedicated Kite route now has owner confirmation, integer quantity, fresh India quote/notional, held SELL, G1/G3 owner-audited overrides, and budget RPC before `placeEquityOrder` (`app/api/kite/order/route.ts:20-218`). It is safer than the earlier audit baseline. Its controls should still be consolidated with the combined gateway to prevent another drift cycle.

### Autonomous path, gate by gate

| Gate | Satisfiable? | Defect |
|---|---|---|
| Deployment env `AUTONOMOUS_LIVE_ENABLED=true` | Yes (`lib/autonomy.ts:29-32`) | Comments still say it is always false (`:8-14,55-58`). Keep false until ranks 1–12 fixed. |
| Global config/read | Yes if missing migrations were applied out of band (`lib/trading/autonomous-live.ts:53-67`) | Clean DB fails; no schema reproducibility. |
| `app_paused`, `security_locked`, `trading_enabled` | Yes (`:70-76`) | These are cached flags, not fresh `checkKillSwitches`. |
| Owner lease | Technically yes (`:78-80`) | Null lease passes; should require a valid future lease. |
| Per-market mode and view-only | Yes (`:83-92`) | Null market flag passes; should require `=== true`. No check of `autonomy_level >= L4`. |
| NAV | US only (`:111-120`) | Wrong account/currency for India. No query error check. |
| Kelly | Yes (`:122-143`) | Cross-market, N=10, flat fallback. |
| Open/order caps | Eventually wrong (`:145-157`) | Historical filled-order count and UTC/global daily count. RPC should be the authoritative per-market count. |
| Qualifying signals | **No in checked-in schema** (`:162-171`) | Selects nonexistent signal confidence and ignores error. Also does not require live-approved strategy lifecycle. |
| Proposal | Yes if migration 139 exists (`:191-209`) | No signal-level unique claim/idempotency. |
| Kernel | Yes (`:238-250`) | Runs before sizing with proposed notional zero, so per-order gate is deferred only to sizing clamp; does not enforce real portfolio/account/kill gates. |
| Quote/sizing | US possibly; India invalid (`:264-282`) | Generic `getQuote` is not explicitly India/Kite quote here; currency/NAV invalid. |
| Atomic budget | Conceptually right (`:296-317`) | RPC source absent, so lock/search_path/count/actor correctness cannot be verified. |
| Broker submit | Code reaches it (`:329-356`) | Direct clients bypass gateway; India cron is after close; no protective exits. |
| Durable reconciliation | Incomplete (`:358-416`) | Persistence failures ignored; all failures marked ambiguous. |

Conclusion: under intended owner configuration, the path does **not** reliably complete in this repository. The correct resolution is not to remove gates. It is to make schema reproducible, use one shared execution service, supply market-correct account/currency state, add signal idempotency and live lifecycle, and prove it with shadow→paper-broker→tiny-live canary tests.

## 6. Statistical-validity audit

### Scoring

- The five core dimensions are deterministic, clamped scores. Their main weakness is not arithmetic but **economic calibration**: hardcoded sector P/E reference bands and heuristic thresholds are not point-in-time cross-sectional estimates (`lib/data/scores.ts:22-155`). For live selection, report raw inputs, percentile ranks within a contemporaneous eligible universe, provider age, and uncertainty rather than treating 0–100 as a calibrated probability.
- Availability renormalization correctly excludes missing/degraded dimensions and abstains for fewer than two (`lib/scoring/weighted-score.ts:27-62`; `lib/research-agent.ts:1010-1038`). The confidence metric is wrong because it counts dimensions rather than structural weights (`lib/research-agent.ts:1372-1374`).
- Champion weight resolution is genuinely connected: market champion overrides profile/global weights (`lib/research-agent.ts:949-1037`). However, legacy fallback to a global champion on query error (`:968-978`) can cross-contaminate markets. After migration enforcement, an error must fail the run, not choose another market’s model.
- LLM text does not set the numeric composite score, but held exits still use LLM direction (`lib/research-agent.ts:1125-1144`). The truthful boundary today is “deterministic numeric score and most new-entry direction, LLM-influenced held exit/abstention,” not “LLM never decides direction.”

### Learning and validation

- Learner evidence uses the broad matured observation ledger rather than only fills (`app/api/agents/learner/route.ts:440-453`), which reduces selection-on-executed-trades bias. Its univariate correlation gate, N=10, and absolute-correlation-as-confidence remain statistically weak (`:453-466`).
- Validation performs purged/embargoed anchored folds (`lib/learning/dataset.ts:89-149`) and deterministic block bootstrap (`lib/validation/engine.ts:159-193`). But the final challenger/champion score is also calculated over all rows (`lib/validation/engine.ts:178-183`); promotion should be based only on concatenated OOS fold observations with explicit effective-N and predeclared objective.
- Calibration has direct train/test leakage as described in rank 14.
- Promotion is human-controlled, but `force_unvalidated` means “fail closed” is not absolute (`app/api/strategies/versions/route.ts:77-89`). An owner can knowingly override, but the result should not silently become the same `paper_active` state as a validated champion.
- Genome bounds are enforced at hydration (`lib/validation/genome.ts:39-69`; `lib/validation/genome-live.ts:65-75`), and the promoted genome genuinely changes paper behavior. There is no evidence that live autonomous sizing/exits consume that market champion genome; auto live instead reads global config/Kelly (`lib/trading/autonomous-live.ts:95-143`).

### Edge lab

- Edge Scout/IC is genuinely measure-only with respect to trading: it writes edge catalog/signals/IC state, and no actionable scorer imports it (`lib/edges/ic.ts:11-12,163-173`; `app/api/agents/edge-ic/route.ts:86-131`).
- The broad universe is still static/current and therefore survivorship-biased (`lib/edges/universe.ts:1-74`). A timestamped record of today’s list does not reconstruct membership ten years ago.
- Cross-sections as small as five and only 12 time observations can pass lifecycle classification (`lib/edges/ic.ts:151-168`). Any-horizon-wins across three horizons and eight edges is multiple testing. Newey-West lag units are inconsistent with five-day sampling.
- These results are suitable for hypothesis triage only. They are not sufficient to alter scoring or capital.

### Label integrity

The ledger’s append-oriented observation/label split is architecturally good. The material defect is session timing: calendar approximation and first candle on/after a missing decision price can use future information relative to the declared decision timestamp (`app/api/agents/label-maturation/route.ts:12-20,88-95`). Labels need explicit execution convention and exchange calendars. Benchmark and asset prices must use the same timestamp and adjustment convention.

## 6b. Autonomy & evolution reality check

### Enabled-autonomy trace

The trace is: Vercel cron (`vercel.json:20-23`) → cron-secret gate (`app/api/agents/autonomous-live/cron/route.ts:9-25`) → `runAutonomousLive` → env/config/lease/mode gates (`lib/trading/autonomous-live.ts:48-104`) → snapshot/Kelly/counts (`:108-157`) → signals (`:159-171`) → proposal/kernel/sizing (`:191-294`) → budget RPC (`:296-327`) → direct broker (`:329-356`) → local audit (`:358-416`).

It does not complete reliably. In the checked-in schema it dead-ends at the signal query. If the production DB has an extra signal column, US may submit but bypasses mandatory safety controls. India is incorrectly sized and scheduled after close. Therefore autonomous mode must remain disabled until the shared-gateway and schema fixes are implemented.

### Per-market owner control

- Independent `off/manual/autonomous` columns exist (`supabase/migrations/141_live_auto_per_market_mode.sql:5-10`).
- Auto selects each market independently (`lib/trading/autonomous-live.ts:83-92`), but market kill flags fail open on null.
- Manual owner-click gateways remain independent and functional.
- Shared global NAV/Kelly/open-order counts contaminate the independence; India and US do not yet have truly separate risk pools.
- One UTC cron is not appropriate for both exchange sessions.

### Learning mechanisms

| Mechanism | Writes rows? | Consumed by decision path? | Loop closed? | Reality |
|---|---:|---:|---:|---|
| Learner weight challenger | Yes: `strategy_versions`, `learning_log` (`app/api/agents/learner/route.ts:507-537`) | Yes, only after owner champion promotion (`lib/research-agent.ts:961-1037`) | Partial | Real connection, but wrong baseline/normalization and weak credit assignment. |
| Validation experiment | Yes (`lib/validation/engine.ts:134-149`) | Promotion route reads passed flag (`app/api/strategies/versions/route.ts:67-80`) | Partial | Overrideable; OOS objective needs hardening. |
| Champion genome | Yes on strategy version | Paper entry/sizing/exit consumes it (`lib/research-agent.ts:1040-1049`; `app/api/agents/paper-trade/route.ts:258-395`; monitor `:103-213`) | Yes for paper | Not consistently consumed by autonomous live. |
| Feature Registry | Yes: registry/history/evaluation (`app/api/validation/feature-check/route.ts:28-76`) | Logged only (`lib/research-agent.ts:1293-1319`) | No | Research telemetry, not evolution. |
| Edge Scout/IC | Yes: `edge_*` | No scorer/trader consumption | No | Proper measure-only lab; not a live learning loop. |
| Archetype experts | Yes: `shadow_decisions` (`lib/research-agent.ts:1435-1484`) | No actionable fills/scoring | No | Shadow A/B candidates only. |
| Calibration artifact | Yes: `model_artifacts` (`lib/validation/calibration.ts:120-132`) | Paper sizing consumes model path (`app/api/agents/paper-trade/route.ts:368-401`) | Connected but invalid | Leakage makes the learned probabilities untrustworthy until refit correctly. |
| Decision labels | Yes: `observation_labels` (`app/api/agents/label-maturation/route.ts:107-126`) | Learner/validation/calibration consume them (`lib/learning/dataset.ts:40-84`) | Yes | Core loop is real; label timestamp/session defects can poison every learner. |
| Trade-memory RAG | Yes | Research prompt consumes retrieved memories | Advisory only | Useful explanation/context; must remain quarantined from numeric credit assignment. |

### Correct balance

Safety and autonomy conflict only if controls are implemented as separate paths. The right design is one deterministic execution kernel/gateway with actor-specific permissions. Owner-manual may supply audited overrides; autonomous may never override but can proceed without a click when every hard invariant passes. Likewise, self-evolution should not mean LLM mutation. LLMs discover hypotheses and explain; deterministic training/validation creates challengers; shadow and paper collect evidence; owner promotes a bounded version; only then does a versioned policy affect capital.

## 7. Docs↔code drift register

| Document claim | Code reality | Correction |
|---|---|---|
| `WORK_LOG.md:41` says migration 139/140 files implement schema/RPC and deployment flag “stays false.” | Files are absent; flag is env-driven (`lib/autonomy.ts:29-32`). | Restore migrations; update log to distinguish deployed DB state from repository state. |
| `docs/arch/04-database-schema.md:768-769` lists 139/140 as migrations. | `supabase/migrations` jumps 138→141. | Mark unreproducible until exact SQL is committed and clean-reset verified. |
| `docs/arch/03-agents.md:469-474` presents auto budget/event flow as implemented. | Calls exist, but backing migration does not; broker path bypasses hardened gateway (`lib/trading/autonomous-live.ts:296-377`). | Document current block and shared-gateway prerequisite. |
| `docs/arch/08-risk-and-safety.md:38` says L4 needs `autonomy_level='L4_live_small_auto'`. | `runAutonomousLive` never reads `autonomy_level` (`lib/trading/autonomous-live.ts:54-104`). | Add it to policy and enforce through `autonomousLivePlacementAllowed`. |
| `docs/arch/08-risk-and-safety.md:220-236` describes ordered auto gates. | Real kill-switch engine, account allowlist, G1/G3 and broker preview are absent from auto. | Replace aspirational list with actual controls until shared service ships. |
| `lib/autonomy.ts:8-14,55-58` says no autonomous code path and always false. | Env true plus DB settings reaches direct broker submit (`lib/trading/autonomous-live.ts:329-356`). | Correct comments and add tests asserting default-off, not “no path.” |
| `lib/research-agent.ts:871` says LLM writes thesis+direction only; architecture elsewhere says LLM never direction. | Held exit consumes LLM short (`lib/research-agent.ts:1125-1144`). | Specify advisory-only schema and mechanical exit. |
| `lib/research-agent.ts:1372-1374` calls confidence an applicable-dimension ratio and says P1 will upgrade. | Requested architecture requires structural weights now; auto attempts to gate on this value. | Implement weighted coverage before auto use. |
| `app/api/validation/feature-check/route.ts:12-14` describes lifecycle toward active. | Active feature is only logged, never scored (`lib/research-agent.ts:1293-1319`). | Rename state/reword UI to “research validated.” |
| Edge docs/work log imply broader IC removed survivorship. | Universe code labels itself static/current (`lib/edges/universe.ts:1-74`). | State survivorship limitation prominently and block promotion. |
| `lib/validation/calibration.ts:91-93` says predictions are OOS. | Coefficients were fit on all rows at `:82-89`. | Correct implementation, not merely wording. |
| `lib/auth/require-owner.ts:5-8` says middleware does not cover `/api`. | Matcher covers all non-static paths, and non-owner sessions are rejected globally (`middleware.ts:25-37,65-66`). | Keep route-level rule, correct comment: middleware is defense-in-depth, not authorization contract. |
| `docs/arch/04-database-schema.md:461` documents `broker_order_events`. | No repository migration creates it. | Restore exact migration or label production-only drift. |
| `AGENTS.md` describes four core agents and Anthropic-centric stack. | Repository now has many agents, DeepSeek/Groq routing, edge lab, RAG, and autonomous paths. | Refresh project entrypoint after code is stabilized; do not use stale registry for operational truth. |
| `PRD.md` describes earlier product phases/provider/deployment assumptions. | Current runtime is split Vercel + Windows tasks with multi-provider routing. | Version the PRD and link current system map; archive superseded sections. |
| `public/agent-diagrams/system-map.json` presents a coherent agent graph. | Scheduling and live-money calls are not a single orchestrated graph; many nodes are independent routes/tail calls. | Add execution-mode/scheduler metadata and mark advisory/shadow/dead nodes visually. |

## 8. What I could NOT verify

1. **Production Supabase state.** I reviewed migrations, not the live project. Because 139/140 are explicitly out-of-band, I could not verify the actual RPC body, advisory lock, search path, grants, constraints, indexes, or event trigger. Prove with `pg_get_functiondef`, `pg_policies`, `pg_trigger`, and schema diff against a clean local reset.
2. **Broker contracts and credentials.** I did not submit or preview real orders. Robinhood’s token compatibility with `api.robinhood.com`, available MCP tools, Kite account state, and broker idempotency must be tested in sandbox/tiny canary after architecture repair.
3. **Deployed scheduler state.** Repository schedules do not prove Windows tasks are enabled or Supabase pg_cron jobs are absent. Export Windows Task Scheduler, query `cron.job`, and inspect Vercel cron logs.
4. **RLS effective state after every migration.** I traced material policy files, but a production schema dump is required to enumerate every table/grant/policy and detect manual changes.
5. **Provider tier/quotas and live data freshness.** Code fallbacks were reviewed; account subscription dashboards and actual rate-limit telemetry were not available. Validate provider budgets with logged request counters and stale-data integration tests.
6. **Full runtime UI correctness.** This audit is source/system focused. It does not replace browser QA across every panel.
7. **Clean build/test outcome at the exact production commit.** The working tree contains concurrent user/Claude worktrees and untracked review artifacts. Run tests/build on the intended clean release commit and a clean database.
8. **Historical market-data quality.** Corporate-action, delisting, and point-in-time fundamental coverage cannot be proven from adapters alone. Audit sampled raw records against authoritative sources.

## 9. Prioritized fix plan

### Target architecture upgrade — what must exist beyond bug fixes

Fixing the defects above will make Kairos safer, reproducible, and statistically more honest. It will **not by itself create market-beating edge**. The following capabilities are the minimum target specification for a credible adaptive quant platform. Claude should treat them as architecture requirements, not optional polish.

#### A. Separate prediction, portfolio construction, and execution

The current composite score conflates heterogeneous evidence into one 0–100 number. Replace the actionable decision contract with three independently testable layers:

1. **Alpha models:** each setup model emits a calibrated expected excess return distribution for a declared horizon: `expected_return`, `p_positive`, `downside_quantile`, uncertainty, feature timestamp, and model/version identifier. Models must be market-, asset-class-, setup-, and horizon-specific where evidence supports it.
2. **Portfolio constructor:** converts compatible forecasts into target weights under gross/name/sector/correlation/volatility/liquidity/turnover/tax constraints. It must optimize the portfolio, not rank isolated symbols and buy the top few.
3. **Execution policy:** converts target-weight deltas into orders using spread, liquidity, market session, price drift, broker state, tax lots, and hard owner caps. It cannot alter forecasts or risk limits.

The LLM may discover hypotheses, extract structured qualitative evidence, identify missing data, and explain decisions. It must not fabricate prices, optimize numeric weights, authorize its own model, bypass evidence gates, or call broker-write tools outside the deterministic gateway.

#### B. Replace one universal score with a small mixture of validated experts

Do not keep adding parameters to one formula. Maintain a deliberately small set of setup experts, initially:

- quality/earnings momentum;
- price/volume trend and relative strength;
- post-earnings drift;
- value/quality inflection;
- ETF/sector rotation;
- India quality-momentum/sector rotation.

Each expert must declare eligible universe, required inputs, horizon, benchmark, turnover expectation, transaction-cost model, invalidation conditions, and supported market. A deterministic router may allocate probability across experts using only observable, timestamped state. Regime conditioning should initially scale exposure and expert mixture—not reverse long-only direction or create an unconstrained bull/bear switch.

#### C. Create a real learnable genome

The learnable policy must be versioned and bounded. It should include, where empirically justified:

- feature membership and transformations from a safe compiler grammar;
- normalized feature weights or model coefficients;
- setup routing thresholds;
- entry threshold and cross-sectional selection rule;
- horizon;
- deterministic exit family and parameters;
- sizing method and caps below owner ceilings;
- eligible universe/liquidity constraints;
- cost and tax assumptions;
- abstention/data-quality requirements.

Owner money ceilings, broker accounts, kill switches, autonomy mode, code, secrets, and ledger history are **not genes**. A learner may propose a challenger genome but cannot promote it. Every genome must have a stable hash and immutable links to dataset, features, labels, code version, provider vintages, and validation results.

#### D. Replace correlation nudging with a disciplined research tournament

The Learner should orchestrate—not personally invent numeric truth. The required lifecycle is:

`hypothesis → measure-only → purged walk-forward → shadow → exploratory paper → champion/challenger paper A/B → owner live-review → capped live canary → scaled/retired`.

Promotion evidence must include:

- predeclared primary objective and horizon;
- purged/embargoed walk-forward performance;
- benchmark-, sector-, and beta-neutral diagnostics where appropriate;
- net-of-spread, slippage, fees, taxes, and turnover estimates;
- deflated/Probabilistic Sharpe or equivalent multiple-testing-aware evidence;
- confidence intervals and effective sample size;
- stability across time blocks, regimes, sectors, and reasonable parameter perturbations;
- drawdown, tail loss, capacity, and liquidity stress;
- comparison against simple baselines such as equal-weight, benchmark, and plain momentum;
- explicit failure and retirement criteria.

No “any horizon passed” or repeated tuning on the same holdout. Maintain a final untouched lockbox period or delayed prospective shadow sample. All experiments, including failures, remain in the registry so the system can estimate research false-discovery rate.

#### E. Make the data plane point-in-time and market-specific

For every observation used to learn, persist `event_time`, `available_at`, `retrieved_at`, provider, raw-record hash, adjustment convention, currency, exchange session, and quality state. Required additions:

- dated universe membership including delisted names;
- point-in-time fundamentals and macro vintages;
- split/dividend/corporate-action consistent prices;
- exchange calendars for NYSE/Nasdaq and NSE/BSE;
- executable decision-price convention;
- provider disagreement/quarantine rules;
- explicit freshness service-level objectives by dimension;
- separate USD and INR NAV, cash, costs, limits, and benchmark accounting.

Missing or degraded evidence produces abstention or wider uncertainty. It must never be silently replaced by an LLM estimate or zero.

#### F. Learn from the broad decision population and prospective experiments

The primary learning dataset must include every eligible symbol considered, including rejected candidates, with immutable feature snapshots and matured forward labels. Executed trades are necessary for execution/slippage and realized-behavior learning, but are a selected sample and must not be the sole alpha dataset.

Use shadow A/B or contextual-bandit-style exploration only inside owner-defined paper/shadow budgets. Exploration may vary bounded strategies, never live money limits. Champion traffic should remain dominant until challengers prove incremental value prospectively.

#### G. Add a performance-truth and attribution layer

For US and India independently, report:

- time-weighted and money-weighted return;
- benchmark-relative alpha and beta;
- Sharpe/Sortino/Calmar with uncertainty;
- maximum drawdown and recovery time;
- hit rate, payoff, expectancy, tail loss;
- turnover, spread/slippage/fees/taxes;
- attribution by setup, feature family, sector, regime, market, holding period, and execution quality;
- paper-versus-live degradation;
- capacity and concentration;
- calibration curves for predicted probability/return versus realized outcomes.

The system should optimize long-run risk-adjusted, net-of-cost utility under the owner mandate—not raw win rate, one-period profit, or the 0–100 score.

#### H. Define autonomous trading as a governed control system

Autonomy is ready only when one shared execution service supports both owner and worker actors, with:

- market/account/currency-pinned state;
- atomic signal claim, budget reservation, and idempotency;
- fresh kill-switch and portfolio checks;
- broker preview/review where supported;
- quote/session/liquidity/drift bounds;
- partial-fill, cancel, reject, timeout, and ambiguous-submit reconciliation;
- deterministic protective exits and resting-order cancellation on kill;
- short owner lease, instant disable, and independent US/India modes;
- tiny initial capital and automatic step-down on degradation;
- immutable decision/order/event lineage and immediate alerts.

Scaling must be a separate owner decision based on prospective live evidence. The agent may recommend a higher envelope; it cannot raise its own ceiling.

#### I. Define success honestly

“Beat the best traders in every market condition” is not an implementable or falsifiable requirement. Even strong strategies have losing regimes, capacity limits, model decay, and irreducible uncertainty. The measurable target should be:

- outperform an explicit investable benchmark **net of all costs and taxes** over a predeclared horizon;
- remain within owner drawdown and tail-risk limits;
- show statistically and economically meaningful prospective evidence;
- degrade safely and abstain when edge/data are weak;
- adapt through governed challengers faster than detected edge decay;
- preserve complete reproducibility and explanation for every decision.

Kairos should support multiple mandates—for example capital preservation, balanced swing, and aggressive swing—without changing the evidence standard. A more aggressive mandate changes risk budget within hard ceilings; it does not lower data quality, validation, or execution safety.

#### J. Required acceptance tests for the upgraded system

The feature is not “100% complete” until automated fixtures prove:

1. the same point-in-time packet produces the same score/forecast and policy hash;
2. future records cannot enter training features or labels;
3. US and India data, NAV, currency, calendars, limits, and models cannot cross-contaminate;
4. missing/degraded dimensions yield the intended confidence and abstention;
5. a promoted market champion changes only that market’s subsequent decisions;
6. an unvalidated/rejected/retired challenger cannot affect paper or live behavior;
7. feature and edge states cannot jump directly from research into money decisions;
8. concurrent cron requests cannot duplicate a proposal, reservation, or broker order;
9. every live path invokes the identical gateway invariants;
10. ambiguous broker responses never retry until reconciliation;
11. kill-switch activation blocks new orders and cancels eligible resting orders;
12. protective exits operate on partial fills and cannot sell more than held;
13. all security roles fail the RLS/auth matrix as expected;
14. clean database replay produces the exact schema and functions expected by code;
15. evaluation reports reproduce from immutable dataset/model/code hashes;
16. prospective shadow and paper performance is compared with predefined baselines before live review.

1. **Freeze autonomous live and repair reproducibility** — ranks 1, 4. Restore exact migrations 139/140, add clean-reset/schema-contract tests, and make query errors fatal/alerted.
2. **Unify the money path** — ranks 2, 5, 10, 11. Extract one server-only Execution Gateway used by owner and autonomous actors; no direct broker writes elsewhere.
3. **Build market/account/currency-correct risk state** — ranks 3, 8, 9, 12, 27. Separate US/India NAV, positions, calendars, caps, Kelly datasets, and schedules; require fresh valid lease/flags.
4. **Add autonomous idempotency and live lifecycle** — ranks 6, 7. Atomic signal claim, deterministic client key, partial-fill/reconcile state machine, protective exit/cancel service, resting-order kill action.
5. **Harden policy provenance** — ranks 13, 15, 19, 20. Positive source/version allowlist, transactional per-market promotion, simplex-normalized challengers from champion, bounded LLM advisory schema.
6. **Repair statistical truth** — ranks 14, 21-25, 27. Fold-local fitting, session-correct labels, weighted confidence, honest effective-N/multiple-testing controls, market/setup calibration.
7. **Close only evidence-worthy evolution loops** — rank 26 and §6b. Connect registry/edges through shadow→paper challenger→owner promotion; do not let “active” jump directly to money.
8. **Complete API/RLS/secrets hardening** — ranks 16-18, 31-32, 34. Owner-gate metered/personal routes, default-deny DB roles, encrypt secrets/hash PIN, rotate historic secret, add security tests and headers.
9. **Consolidate production scheduling and observability** — ranks 12, 28. One managed scheduler, exchange calendars, distributed run locks, retries, durable heartbeat/alerts, no simultaneous local+cloud execution.
10. **Fix past-trade evidence before using it for learning** — ranks 29-30. Robust immutable ingestion, fill/episode identity, session/corporate-action-consistent enrichment, versioned derived labels.
11. **Reconcile documentation only after code** — §3 and §7. Generate route/schedule/schema diagrams from source where possible and clearly label target vs implemented architecture.
12. **Release gates before first autonomous dollar:** clean DB replay; typecheck/test/build; owner/non-owner/RLS test matrix; broker paper/sandbox integration; duplicate-cron and ambiguous-submit chaos tests; US and India currency fixtures; 30+ trading-day shadow soak; capped tiny-live canary with deterministic exits and immediate owner kill/cancel drill.
