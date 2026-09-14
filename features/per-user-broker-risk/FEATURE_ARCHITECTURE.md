# Feature Architecture: Per-User Broker Connections & Private Risk Analytics

## Status

Architecture status: Approved
Architecture approved: Yes (owner, 2026-09-14)
Approved scope: Phases 0-3
Approved date: 2026-09-14
Implementation allowed: Yes, phase by phase

**Open Decision 1 (the daily Kite login) is RESOLVED: option (a).** The owner
accepts that each India guest must log in to Zerodha every trading day, on the
condition that staleness is shown **loudly** — on the page and in the email —
rather than a stale number being presented as current. That obligation is
binding on Phases 2 and 3: a risk figure computed from a token that expired is
never rendered as if it were today's.

Relationship to the other two documents:

| Document | Status |
|---|---|
| `features/shared-viewer-access/` | **Built.** Phases 0-2 shipped 2026-09-14. Read-only viewers, no data of their own. |
| **This document** | Adds a *private* data plane on top: a guest connects their own broker and sees risk analytics on their own holdings. |
| `features/multi-tenant/` | Deferred. Full tenancy (own book, own genome, per-user learning). This feature is a strict subset of it. |

This is the first feature that gives a non-owner **private rows of their own**. That
is a category change from viewer access, and most of the design below exists to
contain it.

---

## Feature Purpose

Let an invited guest connect their own Robinhood (US) and/or Zerodha Kite (India)
account, read-only, and see risk analytics computed on **their** holdings — never
the owner's, and never pooled. Optionally, receive a daily risk email if they opt
in.

The owner's book, research, learning and paper portfolio are unaffected. Nothing
about this feature lets a guest trade, and nothing lets the owner see a guest's
holdings.

## Scope

- Per-user, encrypted, **read-only** broker credentials for Robinhood and Kite.
- A per-user live holdings snapshot and a per-user risk analytics run.
- Private risk pages showing only the signed-in user's own accounts.
- Opt-in daily risk email, per user, with unsubscribe.
- Tenant isolation (`user_id` + RLS + service-role query guards) on the private
  data plane only.

## Non-Goals (explicitly OUT of scope)

- **Any order path for a guest.** No place, cancel, exit, stop, or Guardian
  action. Read-only broker scopes only, enforced structurally (below), not by
  convention.
- **Any pooling.** A guest's holdings never enter the owner's research, scoring,
  learning, paper book, or shadow evidence — and never another guest's.
- **Owner visibility into guest holdings.** The owner administers *access*, not
  *positions*. The owner is not an exception to isolation here.
- Per-user paper books, genomes, or learning loops (that is `multi-tenant/`).
- Guest access to the owner's live portfolio, which stays owner-only.

---

## Current Behavior (verified against code + production, 2026-09-14)

Everything broker-related is single-account by construction.

| Concern | Today | Evidence |
|---|---|---|
| Broker credentials | One global row per fixed `key_name` in `api_key_vault` | `lib/brokers/mcp-driver.ts` `vaultSet`, `lib/brokers/mcp-registry.ts` `vaultKeys` (e.g. `WEBULL_MCP_ACCESS_TOKEN`), `lib/kite.ts` `VAULT_ACCESS_TOKEN` |
| `api_key_vault` shape | `key_name, key_value, provider, …` — **no user column** | production `information_schema` |
| Live holdings | `live_account_snapshots`, `live_performance` — **no user column** | production |
| Risk output | `holding_risk_runs`, `holding_risk_snapshots` — **no user column**, owner-email-pinned RLS | production |
| Risk inputs | `fetchRobinhoodBrokerAccounts` / `fetchKiteBrokerAccount` + `fetchUsCandles` / `fetchYahooCandles` | `app/api/agents/holding-risk/route.ts` |
| Scheduling | `kairos-holding-risk-{us,india}`, `kairos-live-snapshot`, `kairos-broker-keepwarm` — one account each | `cron.job` |
| Email | Resend (or SMTP) via `lib/providers/email` | `lib/providers/email/index.ts` |

### The one piece of good news, and it is load-bearing

Market data does **not** scale per user. `lib/data/candles.ts` fetches through
`providerCachedFetch`, day-cached per symbol under a per-provider budget. Two
users holding AAPL cost one AAPL candle fetch, not two. The same is true of
`price_cache`.

So the per-user cost is **broker API calls only** — which are per-account by
nature and not something caching can fix, but are also not metered against the
market-data budgets that are already strained (Alpha Vantage over its default,
Massive at ~5 req/min).

### The three hard problems

**1. Credentials.** `api_key_vault` is a global key/value store addressed by fixed
names. It cannot hold two users' Robinhood tokens. It also mixes *app* provider
keys (Massive, Alpha Vantage) with *broker* credentials; overloading it further
would put guest secrets in the same table the owner's admin vault UI edits.

**2. Kite tokens expire daily.** Zerodha's access token is good for one trading
day; the work log already records "a stale Kite daily token just skips the day".
Today that is one daily login for the owner. With N guests it is **N daily
logins**, each of which only that guest can perform. This is a Zerodha platform
constraint, not something the design can engineer away, and it is the single
biggest UX risk in this feature.

**3. Cron fan-out returns.** The viewer feature's cost guarantee was "no per-user
crons". This feature breaks that by necessity — but only for two jobs, and the
order-path jobs must be excluded outright:

| Job | Fans out? | Why |
|---|---|---|
| `kairos-live-snapshot` | yes | per-account holdings refresh |
| `kairos-holding-risk-{us,india}` | yes | per-account risk |
| `kairos-broker-keepwarm` | yes | per-account OAuth refresh |
| `kairos-manual-fill-detect` | **no — never** | order-path; guests are read-only |
| `kairos-live-exit-monitor` | **no — never** | places protective exits |

---

## Proposed Behavior

### 1. Credentials: a new table, not the vault

`user_broker_credentials`, separate from `api_key_vault`:

- Keyed `(user_id, broker)`; `broker in ('robinhood','kite')`.
- Ciphertext only. Encrypted with a server-held key (env), never with anything a
  client can reach. The plaintext token is never returned by any API, never
  logged, never rendered — the UI shows connection *state*, not secrets.
- `scope` column, constrained to `read_only` at the check-constraint level. There
  is no value that means "can trade", so a future bug cannot widen it silently.
- RLS: a user reads only their own row; **no read policy for the owner**. The
  owner sees that a connection exists via a separate non-secret status view, not
  the credential row.
- Revoking viewer access (Phase 1 of the viewer feature) must also disable the
  credential — one revocation, both effects.

The existing global `api_key_vault` keeps the owner's own broker tokens unchanged.
Do not migrate the owner into the new table in the same change; that is a separate,
later cleanup with its own rollback.

### 2. Read-only enforcement, structurally

The Robinhood MCP surface exposes `place_equity_order`, `cancel_equity_order` and
friends. "Guests are read-only" must not rest on nobody calling them:

- Guest credentials are loaded through a **separate client factory** that binds
  only the read tools (`get_equity_positions`, quotes, balances). The order tools
  are not reachable from that object at all.
- Every order-capable route keeps `requireOwner()`. Being a connected guest grants
  nothing on those routes.
- The `605420660`-only order-placement rule in `CLAUDE.md` is unchanged and
  unaffected; guest accounts are never candidates for it.

### 3. Isolation of the private data plane

`user_id` (not null, FK `auth.users`) on: `user_broker_credentials`,
`user_account_snapshots`, `user_holding_risk_runs`, `user_holding_risk_snapshots`,
`user_risk_email_prefs`.

**New tables, not new columns on the owner's tables.** Adding `user_id` to
`live_account_snapshots` / `holding_risk_snapshots` would put guest rows in the
tables the owner's live pages, kill-switch baseline and Guardian read — one missed
filter and a guest's position silently enters an owner money-path calculation.
Separate tables make that class of bug impossible rather than merely tested-for.

RLS: `user_id = auth.uid()` for reads; service-role for writes. Per
`docs/arch/07-coding-conventions.md`, every service-role read of these tables
carries an explicit `user_id` filter — RLS is the backstop, the filter is the
mechanism.

### 4. Per-user risk pipeline

One job per market iterates *connected, non-revoked* users, and for each:

1. Fetch holdings with that user's read-only credential.
2. Compute risk with the existing `computeRiskMetrics` / `computeCorrelationClusters`
   — unchanged code, different input.
3. Write `user_holding_risk_*` rows scoped to that user.

Candles come from the shared cache, so a symbol a guest holds that the owner's
universe ALREADY covers is free. **Correction to an earlier claim in this
document that market data does not scale per user at all**: a guest symbol
OUTSIDE that universe has no cached day-row, so the first risk run for it costs a
real provider fetch, and the day-cache only makes it free from the second reader
onward. The honest statement is that cost scales with the number of DISTINCT new
symbols guests introduce, not with the number of guests — which is much flatter
than per-user, but not zero. Phase 2 must measure that set before fanning out. A
user whose credential is missing, expired or revoked is **skipped with a recorded
reason**, never silently, and never falls back to the owner's data.

### 5. Opt-in daily risk email

- Off by default. `user_risk_email_prefs` holds the opt-in, the send hour, and an
  unsubscribe token.
- Content is built **only** from that user's own `user_holding_risk_*` rows. The
  owner's book, research, and signals are not included — that would turn a risk
  report into a recommendation, which is the thing this feature deliberately is not.
- One send per opted-in user per day, with a per-send audit row and a hard cap so
  a scheduling bug cannot mail in a loop.
- Every email carries a working unsubscribe that flips the opt-in without a login.

### 6. Cost model

| Cost | Scales with | Mitigation |
|---|---|---|
| Broker API calls | users × jobs/day | Only 3 jobs fan out; snapshot cadence for guests can be lower than the owner's 2-hourly |
| Market data (candles, quotes) | **distinct symbols**, not users | Already day-cached per symbol; overlap is free |
| LLM | should be **zero** for guests | Guest risk is the deterministic scorer only. No LLM prose note. Stated as a rule, enforced by the guest pipeline not importing the LLM client |
| Email | users × 1/day | Trivial at this scale |

The rule that keeps this true: **a guest-triggered path may call a broker, and
may read cache, but may never call an LLM or a metered market-data provider
outside the shared cache.**

---

## Phased Rollout

| Phase | Content | Gate to next |
|---|---|---|
| 0 | Schema + RLS + encryption, no UI, no job. Tables exist and are empty. | Isolation matrix passes with two seeded test users |
| 1 | Connect/disconnect flow for the signed-in user; read-only client factory; connection status only | **DONE 2026-09-14.** A guest can connect and disconnect; no order tool is reachable |
| 2 | Per-user snapshot + risk job; private risk page | A guest sees only their own; owner's pages byte-identical |
| 3 | Opt-in daily email + unsubscribe | Send audit shows exactly one mail per opted-in user |

Phases 2 and 3 each add scheduled work; neither may ship before the cost rule in
§6 is verified against real usage — including the corrected form of it: the count
of distinct symbols guests hold that are NOT already in the owner's cached
universe.

**Phase 1 as shipped.** `/dashboard/connections` (viewer-reachable) plus
`/api/broker-connections` (GET state, POST disconnect) and
`/api/broker-connections/kite/login`. Zerodha registers one redirect URL per app,
so guests reuse `/api/kite/callback`; which account a token belongs to is decided
from the HMAC-signed state cookie (`guest:<userId>`), never from the session,
because a session can be absent on a redirect and falling back to the owner path
would let a guest's token overwrite the owner's vault entry. The guest branch
never touches `api_key_vault`, `storeAccessToken`, `broker_accounts` or
`strategy_config`. Staleness is rendered as a full-width amber banner reading
"Your figures are out of date." with a Reconnect action — the owner's stated
condition for accepting the daily login. Robinhood is declared unsupported and
shown as "Coming soon" rather than offering a button that fails. No job runs and
no risk figure is computed yet; connecting today stores a credential and nothing
else consumes it.

## Acceptance Tests

As with the viewer feature, negative tests are issued **directly against
PostgREST with each user's JWT**, not through the UI.

1. Guest A cannot read guest B's credential, snapshot, risk run, or email prefs.
2. The **owner** cannot read any guest's credential row or holdings. (Deliberate:
   the owner administers access, not positions.)
3. A guest's session cannot reach any order-capable route, and the guest client
   factory exposes no order tool.
4. A revoked viewer grant disables the broker connection and stops the per-user
   jobs on the next run — not merely the navigation.
5. A guest's holdings never appear in the owner's `live_account_snapshots`,
   `live_performance`, kill-switch NAV baseline, paper book, research inputs,
   learner evidence, or any shadow ledger. Asserted by row counts before/after a
   guest run.
6. An expired Kite token produces a recorded skip with a reason, never a fallback
   to the owner's account and never a partial risk number presented as complete.
7. No guest-triggered path calls an LLM — asserted against `llm_call_log` across
   a full guest cycle.
8. Unsubscribe works without a login and stops the next send.
9. Plaintext credentials appear in no response body, no log line, and no error message.
10. Full suite, typecheck, production build, migration applied and rollback-verified.

## Open Decisions (for the owner)

1. **The daily Kite login.** Each India guest must log in to Zerodha every trading
   day or their risk report silently goes stale. Options: (a) accept it and make
   staleness loudly visible; (b) India guests get US-only analytics; (c) defer
   India entirely to a later phase. **Recommendation: (a), with the staleness
   shown on the page and in the email.** This should be decided before Phase 0 —
   it changes what gets built.
2. **Who pays for broker-driven load**, and what per-guest cap applies. This is
   lighter than the market-data question (broker calls are not metered against the
   strained provider budgets) but should still have a stated ceiling.
3. **Snapshot cadence for guests** — the owner's is 2-hourly; daily is likely
   enough for risk analytics and costs a fraction.
4. **Does the owner get *any* visibility into guest holdings?** This design says
   no. If the answer is yes for support reasons, it must be an explicit,
   audited, guest-consented path — not an implicit owner exemption.

### On the regulatory question

Worth stating plainly because it differs from the viewer feature: computing risk
analytics on a person's **own** holdings, shown only to them, is materially less
exposed than sharing the owner's research and signals with people who may trade on
them. It is analysis of their data, for them, with no recommendation. That is not
legal advice and the gate on the viewer feature's research page still stands — but
this feature does not widen it, and the daily email must stay descriptive
(exposure, concentration, correlation) rather than prescriptive (buy/sell/hold) to
keep it that way.

## Update triggers (per CLAUDE.md)

If approved and implemented, the SAME change must update:
`docs/arch/02-tech-stack.md` (per-user broker credential store),
`docs/arch/04-database-schema.md` (new tables + RLS),
`docs/arch/05-crons-and-scheduling.md` (**the per-user fan-out jobs — this feature
does add crons, unlike shared-viewer-access**),
`docs/arch/06-env-variables.md` (credential encryption key),
`docs/arch/08-risk-and-safety.md` (guest read-only boundary, order-path exclusion),
`PROJECT_DECISIONS.md`, and `public/agent-diagrams/system-map.json` (a new
per-user data plane is a flow change).
