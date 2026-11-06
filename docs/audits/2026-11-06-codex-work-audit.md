# Codex work audit, 2026-10-15 to 2026-11-06

Reviewer: Claude (Sonnet 5.5) · Date: 2026-11-06 · Baseline: `origin/main` at `a575ccb6` (274 commits, 129 work-log rows by Codex since 2026-10-14).

Method: work log and commit inventory; full typecheck and test run on the baseline; read-only production SQL (alerts, cron health, run outcomes, mark ledger, migrations applied vs repo, Supabase security advisor); targeted source review of money-path, auth and new autonomous-loop code. Nothing below depends on tests alone: the baseline was green (`tsc` clean, 4,745 tests passed) and still contained two production defects, because both live at integration boundaries tests did not cross.

## 1. Verdict

Codex's reliability work is mostly sound: fail-closed auth during outages, owner-approved Vault change with masked keys and no leftover PIN hash, idempotent trial registration, DST handled with month-range and `local_slot` schedules, migrations all applied (names match; only timestamp skew), cron failures 0 in 3 days, no live broker orders in 25 days, security advisor shows no errors. Two defects were serious and were not caught by Codex's own verification; both are fixed in this change set.

## 2. Findings

### Fixed in this change set

| # | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| 1 | **Critical** | US paper marks (and therefore NAV, stops and targets) were one session stale from 2026-11-03 onward while the ledger said `stale=false` | `paper_position_marks`: the 11-06 MSFT mark has `observed_at = 2026-11-05 21:00:01`, `age_days 1.01`, `stale=false`, reason "fresh quote". 11-03 NAV equals 11-02 NAV to the cent. Settle-check tainted 11-03, 11-04 and 11-05 and raised a critical that nothing acted on. Yahoo itself had the correct 11-06 close (530.61 at 21:00:01 UTC) | `quoteIsFromSession` guard in the monitor and in `getSettledDailyQuotes` (a quote the exchange stamped on an earlier session is dropped before marks and exits); settlement Yahoo reads bypass the Next data cache (`cache: "no-store"`, the 15-minute `revalidate` is stale-while-revalidate); second post-close run `kairos-position-monitor-retry` (16:45 ET, DST-safe via `local_slot`); settle-check judges the latest mark per position so a retry supersedes. 10 regression tests |
| 2 | **Critical** | Autonomous strategy tournament could never persist an evaluation | `apply_autonomous_rule_evaluations` reads `config_id` / `selector_version` (snake_case) but the caller sent `configId` / `selectorVersion`, so every call raised "evaluation candidate is not an active market-local shadow". Reproduced against production inside a rolled-back transaction: camelCase-only payload fails with that exact message, adding the two snake_case keys succeeds. `strategy_template_paper_evaluations` has 0 rows. The shadow config itself was only created 2026-11-06 21:00 UTC, so the first real tournament run hit the bug and raised `autonomous-rule-tournament:us` critical | `toRpcEvaluation` sends both spellings; no migration needed; 5 contract tests including one that pins the keys the deployed SQL reads |
| 3 | Low | Two dead symbols failed every price prewarm and kept chronic warns open | `IXAZ6` (admitted by `screener_momentum` 2026-11-04; Yahoo "Not Found", futures-style code) and `UNIVAFOODS.NS` (close frozen at 9.48 since 2026-09-28, no trading). Neither is held | Used the documented remedy: watchlist rows with `research_enabled=false` (same as delisted ABB/IRBT/TMHC). Root cause below |

### Open: needs an owner decision or a larger change

| # | Severity | Finding | Recommendation |
|---|---|---|---|
| 4 | Medium | Screeners admit symbols they cannot price (IXAZ6, UNIVAFOODS.NS, CASHCAT-USD), which then fail every prewarm forever | Add an admission-time check (a recent bar with volume, or an explicit unresolvable verdict) and an auto-quarantine after N consecutive prewarm failures that records itself in the watchlist. Not done here because it changes admission behaviour |
| 5 | Medium | Claude/Codex council members depend on an awake, signed-in laptop: 63 India member jobs expired unclaimed in the last 24 h; 59 jobs queued over 120 min | Known design limit. Only DeepSeek runs in the cloud. Move member transport to an API or a cloud runner if no-laptop operation is a requirement |
| 6 | Medium | US paper trading is under a circuit breaker ("30-day accuracy 33% below 35%"). From 2026-11-03 to 11-06 exits and accuracy were computed on one-session-stale marks | Re-read the 30-day accuracy after the first fully current sessions (fix 1) before deciding whether to reset the breaker |
| 7 | Low | Sentiment availability alert is a per-run reading (14 symbols can read 64%) | Already guarded (critical needs >= 20 applicable symbols). Day-level availability recovered from 83-87% (Oct 26-30) to 89-94% (Nov 2-6); the remaining misses are thematic ETFs (REMX, JQUA, EPI, INDY, BOTZ, USO) |
| 8 | Low | `discovery-alpaca:us`, `crypto-native-daily-candle-freshness` (CASHCAT-USD), Kite expiry (daily), Guardian India coverage | Provider entitlement / owner re-login; no code defect found |
| 9 | Low | `run-failed:sqqq_cron` classifies a benign `no_entry` / `intraday_bars_missing` outcome as an error run | Treat `no_entry` with a named reason as a completed run, keep missing intraday bars as a data warning |
| 10 | Info | Supabase advisor: `pg_net` in `public`, `get_daily_ai_count` callable by `authenticated`, leaked-password protection disabled, 117 deny-all tables | Previously known and deferred; enabling leaked-password protection is a dashboard toggle |
| 11 | Info | Leveraged doors poll every ~5 min intraday (about 390-435 runs per door in 5 days) | Within Codex's free-tier plan; watch `agent_runs` growth |
| 12 | Info | Process: 129 work-log rows in three weeks, many "R27 replay checkpoint n", and two of the criticals above surfaced only as alerts | Prefer one row per deliverable; when a critical alert fires on a new path, treat it as a release blocker rather than "natural run pending" |

## 3. Pending items from the work log (as of 2026-11-06)

| Item | State |
|---|---|
| Autonomous strategy discovery / tournament | Fixed here (finding 2); needs about 60 paired forward sessions before any selection can occur, so nothing is selectable for months |
| Strategy discovery expansion (dimension / source / formula, existing LLM roles) | Architecture ready for review, runtime unchanged; awaiting owner decision |
| Empty autonomous strategy flow diagnosis | Architecture ready; implementation not started |
| India after-hours event shadow | Next natural-run verification pending |
| Guardian target/stop display, council score coverage, DeepSeek release labels | Completed and production verified |
| R27 / adaptive-quant replay | Closed (checkpoint 16 and acceptance CI) |
| R22 autonomous sizing | Deployed fail-closed; calibration artifact is an intentional blocker |
| R24 Robinhood trade-history mirror | Parser fixed; broader mirror pending |
| Replay / matched-replay evidence | Pilot status reconciled; portfolio replay programs still missing |

## 4. What was verified and not changed

Middleware fails closed (503, no data) on auth timeout; Vault PIN removal is Decision 82 with masked keys, same-origin writes and no stored PIN hash left; `register_trial` idempotent; production migrations all applied (7 repo versions differ from applied only by timestamp, names identical; `restore_evidence_prewarm_crons` is a clean-replay baseline whose jobs already exist in production); DST prewarm schedules use month ranges (October EDT, November-March EST; shoulder weeks run 1 hour late, harmless); `market_controls.us.trading_enabled=false`; zero broker orders in 25 days.

## 5. Not reviewed

Individual strategy-template compilation and combination code, the evolution supervisor internals, the leveraged live protective-order reconciliation logic (inert: no live orders), Webull/Alpaca adapters beyond auth, and the 70+ docs-only commits.
