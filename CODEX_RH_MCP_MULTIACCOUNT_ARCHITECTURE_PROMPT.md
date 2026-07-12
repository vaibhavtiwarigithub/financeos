# Codex Review — Robinhood MCP Multi-Account Live Holdings Architecture

You are Codex, doing an adversarial architecture + code review of a proposed data-flow
change in the Kairos (FinanceOS) codebase. Your job is to **verify the claims below
against the actual code and the live Robinhood MCP behavior, and correct anything wrong**
before implementation begins. Do not rubber-stamp. If a claim is false, say so and cite the
file/line or the tool response that disproves it. If the design has a hole (timeout,
pagination, price accuracy, partial failure, RLS, account allowlist, currency), flag it.

Output format:
1. **Verdict** — APPROVE / APPROVE-WITH-CHANGES / REJECT.
2. **Claim-by-claim verification** — for each numbered claim, mark CONFIRMED / REFUTED /
   UNVERIFIABLE with evidence (file:line or tool result).
3. **Design holes** — concrete failure scenarios the proposal does not handle.
4. **Corrected architecture** — the amended proposal, ready to implement.

---

## Context: what Kairos is doing here

Kairos surfaces per-account, per-holding risk analytics ("Portfolio Risk" / "Live Portfolio"
dashboard pages) for the owner's real Robinhood accounts. The owner has **6 Robinhood
accounts**. Only **1** account (`605420660`) is `agentic_allowed=true` (permitted for order
placement). The other 5 are read-only holdings we want to analyze but never trade.

The daily `holding-risk` cron computes risk per account and writes `holding_risk_runs` /
`holding_risk_snapshots` / `account_risk_snapshots`. The dashboard reads those. Right now
**none of the 6 Robinhood accounts appear** — only the internal paper book does.

## Why we want the change

Owner's stated intent (verbatim): *"I want the live account, holdings to come from robinhood
mcp and not windows scheduler! that was before we had mcp working!!"*

Live holdings must be pulled through the **Robinhood agentic MCP** (cloud JSON-RPC over HTTP,
authenticated by the shared-vault OAuth token that Claude Code Cloud reuses), NOT the retired
local Windows-Scheduler `claude-exec` capture path, and NOT the classic REST API.

## What we have now (claims to verify)

**C1.** The `holding-risk` cron (`app/api/agents/holding-risk/route.ts`) enumerates Robinhood
accounts via `fetchRobinhoodBrokerAccounts()` in `lib/brokers/index.ts` (~line 82).

**C2.** `fetchRobinhoodBrokerAccounts()` calls `rhFetchAccounts(svc)` + `rhFetchAllPositions(svc)`
from `lib/brokers/robinhood/rest-client.ts`, which hit `https://api.robinhood.com` (`RH_API`
const, `/accounts/` at ~line 260, `/positions/` at ~line 281).

**C3.** The MCP OAuth token stored in `api_key_vault` (key `ROBINHOOD_MCP_ACCESS_TOKEN`) is
**scoped to the MCP gateway only**. Against `api.robinhood.com` and `trading.robinhood.com` it
returns `401 rejected client id`. Therefore the REST path in C2 has never returned holdings for
this token, and `rhAccounts.length === 0`.

**C4.** When `rhAccounts` is empty, `fetchRobinhoodBrokerAccounts()` returns a single
`{ source:"robinhood", accountId:"unknown", holdings:[], error }` account. The cron
(`processAccount` / the loop that pushes `skipped`) treats `accountId === "unknown"` as skipped
and never persists a run. Net: Robinhood never lands in `holding_risk_runs` (only `internal`).

**C5.** The configured live source is `strategy_config.live_account_source = 'robinhood_mcp'`
with `robinhood_mcp_enabled = true` and `active_account_us = 605420660`.

**C6.** `refreshViaMcp()` in `app/api/live-account/refresh-snapshot/route.ts` calls
`queryRobinhoodAccount(tradingAccount)` and upserts **only the single active account**
(605420660) into `live_account_snapshots`. `queryRobinhoodAccount()` (`lib/robinhood-mcp.ts`
~line 649) calls `get_accounts` (which returns ALL accounts) but then prices only ONE resolved
account.

**C7.** The 6-account data currently sitting in `live_account_snapshots` (captured 2026-07-10,
all rows same timestamp) came from the retired Windows-Scheduler `claude-exec` path, not from
the MCP. `live_account_snapshots.positions_json` stores `{qty, symbol, quantity, avg_price,
average_buy_price, ...}` with **no `current_price`**.

## Live MCP facts we verified (verify these are plausible / re-verify if you can)

Against `https://agent.robinhood.com/mcp/trading` using the vault token, protocol
`2025-06-18`, JSON-RPC: `initialize` → `notifications/initialized` → `tools/call`:

**L1.** `get_accounts` → 200, returns `data.accounts` with 6 entries. Only `605420660` has
`agentic_allowed=true`; the other 5 are `false`. All `state=active`.

**L2.** `get_equity_positions {account_number}` → 200 for **every** account (including the 5
non-agentic ones). Position rows carry `quantity` + `average_buy_price` but **no current price**.
Counts observed: 965848641→4, 605420660→1, 991989781→5, 116781169200→2, 181262410481→15,
5QZ42862→0.

**L3.** `get_portfolio {account_number}` → 200 for every account; returns `data.total_value`,
`equity_value`, `cash`, `buying_power`.

**L4.** `get_equity_quotes` exists in `tools/list` and can supply current prices.

**L5.** Conclusion: `agentic_allowed=false` gates **order placement only**, not reads. So all 6
accounts' holdings are fetchable live via MCP with the existing token.

**→ Verify L1–L5 independently if you have MCP access. If you cannot call the MCP, mark them
UNVERIFIABLE and review the design assuming they hold.**

## Proposed architecture (review this)

**P1 — New capture primitive.** Add `captureAllRobinhoodAccounts()` to `lib/robinhood-mcp.ts`:
- Open **one** MCP session (reuse `openSession` / `mcpRpc` primitives).
- `get_accounts` → iterate all 6.
- Per account: `get_equity_positions {account_number}` + `get_portfolio {account_number}`.
- Dedupe the union of held symbols; batch `get_equity_quotes` to get `currentPrice`.
- Return `BrokerAccount[]` with **real account ids** and priced holdings
  (`currentPrice`, `marketValue = qty*price`, `costBasis = qty*avg`), matching the exact
  `BrokerAccount` / `BrokerHolding` shape holding-risk already consumes.

**P2 — Repoint the cron source.** Rewrite `fetchRobinhoodBrokerAccounts()` to call
`captureAllRobinhoodAccounts()` instead of the dead REST client. All 6 accounts (real ids) then
flow through `processAccount` into `holding_risk_runs`.

**P3 — Repoint the live snapshot.** Change `refreshViaMcp()` to loop the same capture and upsert
**all 6** accounts into `live_account_snapshots` (currently only the 1 active). Live Portfolio
page then shows all 6.

**P4 — Dead-code marking.** Leave `rest-client.ts` in place but mark it dead (the MCP token can
never authenticate against it); deletion is a separate cleanup PR.

**P5 — Docs in same commit.** Update `docs/arch/03-agents.md` (Robinhood live source = MCP, all
accounts, not REST/scheduler) and `public/agent-diagrams/system-map.json` (fix diagram + nodes +
append history entry), per repo CLAUDE.md rules.

## Trade-offs / open questions we want you to pressure-test

- **T1 — Round-trip cost / timeout.** ~2–3 JSON-RPC calls × 6 accounts + 1 quote batch ≈ 13–19
  sequential calls in one SSE session. Is this safe inside the Vercel serverless timeout for
  this route? Should per-account calls be parallelized within a session, or does the single SSE
  stream force sequential? Is a per-account failure isolated (one bad account shouldn't null the
  whole capture)?
- **T2 — Price accuracy.** Is `get_equity_quotes` last-trade/mid sufficient for risk marketValue,
  or does `get_portfolio.equity_value` per account need to reconcile against summed holdings?
  What if a symbol has no quote (halted/delisted)?
- **T3 — Pagination.** Can `get_equity_positions` paginate for large accounts (15+ holdings)? Do
  we need a cursor loop?
- **T4 — Token refresh mid-capture.** `getValidAccessToken` does CAS refresh. If the token rolls
  over between the session open and a later call, does the open session stay valid, or must we
  pin one token for the whole capture?
- **T5 — Currency / account type.** One account is `joint_tenancy_with_ros`. Any account-type or
  currency assumptions in the `BrokerAccount` shape or downstream risk math that break with
  joint/margin accounts?
- **T6 — Allowlist safety.** Confirm this READ path cannot accidentally widen the ORDER-placement
  allowlist. Order placement must remain restricted to `605420660`; enumerating/reading the other
  5 must not make them tradeable anywhere in the Gateway/adapter.
- **T7 — Should holding-risk read from `live_account_snapshots` (DB, MCP-populated) instead of
  calling MCP directly in the cron?** Two consumers (cron + live page) both need the same capture.
  Is a single capture → DB → both read cleaner than each calling MCP? Weigh freshness vs. MCP load
  vs. the owner's "must come from MCP" intent (DB populated by MCP still satisfies intent).

## Repo rules the implementation must honor (from CLAUDE.md)

- Architecture-first: this is a data-flow/contract change; propose → approve → implement.
- Update the relevant `docs/arch/` chapter + `system-map.json` in the **same commit** as the flow
  change.
- Auto `npm run build` after edits; push to `main` after a clean build (auto-deploys Vercel;
  crons hit the deployed URL).
- Mobile-first for any UI touched.
- Schema-coupled code: if any new column/table is introduced, verify the migration is applied to
  the target DB before shipping (none is currently proposed — confirm the plan truly needs no
  migration).
- Order placement stays restricted to account `605420660`; `965848641` is read-only.

Now: verify C1–C7 and L1–L5 against the code/tools, pressure-test P1–P5 and T1–T7, and return the
corrected architecture.
