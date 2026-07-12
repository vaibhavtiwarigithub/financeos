# Codex Review Result — Robinhood MCP Multi-Account + Risk Analytics

**Reviewed/fixed by Codex, 2026-07-11**
**Scope:** `CODEX_RH_MCP_MULTIACCOUNT_ARCHITECTURE_PROMPT.md`, live Risk Analytics UI,
US/India APIs, MCP capture, Supabase snapshots, holding-risk daily publisher, and risk math.

## Verdict

The prompt's central diagnosis was correct. The OAuth token is valid for
`https://agent.robinhood.com/mcp/trading`, but `fetchRobinhoodBrokerAccounts()` was sending it
to Robinhood's private REST endpoints. That made the live US path disappear and caused the
daily holding-risk run to contain only the internal paper account. The India pipeline was
currency-isolated correctly, but its live Kite branch is currently unavailable because the
daily Kite token is expired; the page now reports that credential state honestly.

The implemented result now discovers and prices all six Robinhood accounts through one MCP
session, persists all six canonical account snapshots, publishes one append-only daily risk run
per account, and keeps the single agentic account separate from the five read-only accounts.
No order/review/cancel MCP tool is used by this feature.

## Findings and fixes

| # | Severity | Finding | Fix applied | Verification |
|---|---|---|---|---|
| 1 | CRITICAL | `fetchRobinhoodBrokerAccounts()` used an MCP-scoped token against private Robinhood REST; every live US account failed. | Added `captureAllRobinhoodAccounts()` in `lib/robinhood-mcp.ts`; `lib/brokers/index.ts` now uses MCP account/position/portfolio/quote tools. | Live UI returned six accounts and 27 priced positions. |
| 2 | HIGH | Quote parsing ignored Robinhood's actual `{ quote: {...} }` wrapper, so every held symbol appeared unpriced. | Unwrap `record.quote`; support documented 20-symbol batches and schema-derived symbols argument. Missing quotes fail the affected account closed. | Live market values and P&L rendered for every held symbol. |
| 3 | HIGH | Stable `account_number` and MCP wire-only `rhs_account_number` were conflated, creating an alias row. | Store/display stable `account_number`; use `rhs_account_number` only for account-scoped MCP calls. Removed the one transient alias cache row created during validation. | Exactly six canonical snapshot rows now refresh together. |
| 4 | HIGH | Snapshot refresh updated only the active trading account, leaving the five read-only account books stale. | `/api/live-account/refresh-snapshot` now persists every successful account from the shared capture; the active account must be present or the refresh fails without overwriting prior snapshots. | All six rows share the new capture timestamp; active NAV and buying power reconcile. |
| 5 | HIGH | The live Risk endpoint silently substituted paper holdings when live broker retrieval failed, presenting paper risk under a live heading. | Removed paper fallback from `/api/portfolio/holdings`; broker failure now yields an honest empty/error state. | Expired Kite token shows a credential error while the separate daily paper panel remains visible. |
| 6 | HIGH | Negative unrealized P&L omitted the minus sign even while the percentage was negative. | Added an explicit Unicode minus prefix for negative dollar P&L. | CRWV, HOOD, LNG, TEM, etc. now display negative dollars and percentages consistently. |
| 7 | MEDIUM | Only account `965848641` was labeled read-only; four other non-agentic accounts looked actionable. | Treat every Robinhood account except `605420660` as read-only in both live pills and daily tabs. | Five read-only badges and one trading account shown. |
| 8 | MEDIUM | A same-day rerun could be selected as “previous” and displayed as `Delta 1d`. | Sort by `captured_on, completed_at` and require `previous.captured_on < latest.captured_on`. | Same-day reruns no longer masquerade as yesterday. |
| 9 | MEDIUM | A negative portfolio beta produced a negative loss magnitude; the UI called a beta-only estimate full VaR. | Use absolute beta for magnitude and relabel it “1-Day Market-Factor Loss (95%)”; disclose that it is not covariance VaR. | UI and help/footer copy are consistent. |
| 10 | MEDIUM | ETFs, Treasuries, gold, bitcoin, and multiple held equities collapsed into `Other` with beta 1.0, making sector/beta output misleading. | Added current held-asset classifications and conservative factor-beta classes; nonexistent S&P sector benchmarks no longer create fake overweight. | Recomputed live risk uses diversified equity, international equity, fixed income, commodities, digital assets, and correct stock sectors. |
| 11 | LOW | The India page displayed a Robinhood reconnect banner and US-specific help text. | Hide the RH banner for India and provide India-specific sector-risk guidance. | US/India help and credential states now match their broker. |
| 12 | LOW | The internal daily account was labeled only `internal`, obscuring that it was paper trading. | Display “Paper Portfolio” with a paper badge. | Daily account tabs distinguish paper from live. |

## Prompt pressure-test answers (T1–T7)

- **T1 timeout/partial failure:** One session is reused. Account work runs with concurrency two;
  each account failure becomes an error stub and cannot erase another account. The route duration
  is 120 seconds. A live six-account capture completed in about 7 seconds; the full post-close
  computation completed in 53 seconds.
- **T2 price accuracy:** MCP real-time/extended-hours last trade prices are used for per-holding
  market value. `get_portfolio.total_value` remains authoritative NAV. Missing prices do not fall
  back to cost basis; the account is skipped to avoid false risk math.
- **T3 pagination:** Robinhood's MCP abstraction currently returned all positions, including a
  15-position account. No cursor was present in the verified payload. If Robinhood later adds a
  cursor, capture must follow it before claiming completeness.
- **T4 token expiry:** The existing refresh-aware CAS token path remains in use. A failed refresh
  returns an error stub and preserves prior DB snapshots.
- **T5 currency/account types:** Robinhood accounts remain USD and independent; Kite remains INR.
  Joint/margin account NAV comes from `total_value`, not a sum of buying power and holdings.
- **T6 allowlist:** Read discovery is scoped by the owner's OAuth connection. All discovered
  accounts may be analyzed, but only `605420660` is treated as agentic/actionable. The execution
  gateway's order allowlist is unchanged.
- **T7 capture topology:** The shared MCP primitive now serves live display, daily risk, and DB
  refresh. DB snapshots are the durable handoff for Live Portfolio/G3. Risk Analytics still takes
  a fresh read on user refresh, while daily risk takes a fresh post-close read; neither trusts a
  stale cache as current.

## Live evidence

- Six canonical Robinhood accounts refreshed into `live_account_snapshots` at one timestamp.
- Account values reconcile as `portfolio_value ≈ priced holdings + available cash` (minor broker
  timing/rounding differences are expected).
- US live view: 27 held positions, approximately `$24,870` invested value, cash excluded and
  explicitly labeled.
- Daily US run: 7 complete accounts (6 Robinhood + paper), 2 unconfigured Alpaca accounts skipped
  with explicit missing-credential reasons.
- India: paper book contains 5 INR positions and renders correctly; live Kite is unavailable until
  the owner completes the daily Kite login. This is **needs credentials**, not a code failure.

## Verification

- `npx tsc --noEmit` — pass.
- `npm test` — 302 passed, 6 skipped.
- `npm run build` — pass.
- Browser: US/India toggle, Help/Hide, Refresh, paper/live account tabs, six live account sections,
  currency symbols, totals, P&L signs, read-only badges, empty/error states — exercised.

## Remaining limitations (not hidden)

1. The top-card loss number is a transparent benchmark-factor proxy, not institutional full
   covariance/historical-simulation VaR. The UI no longer calls it full VaR.
2. India live values require a fresh daily Kite token. Re-login is an owner credential action.
3. Robinhood MCP pagination must be added if its future tool schema introduces a cursor.
4. The old private REST adapter still exists because the order subsystem references it elsewhere;
   this review removed it only from holdings/risk capture. Its live-order suitability remains a
   separate money-path decision and was not changed here.
