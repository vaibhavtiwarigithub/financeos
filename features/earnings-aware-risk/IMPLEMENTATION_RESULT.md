# Earnings-Aware Risk P0 Implementation Result

Date: 2026-07-29
Status: Complete and deployed to production schema
Policy: `v1`, `shadow` only

## Shipped

- Source-aware US earnings resolution across the existing PIT calendar,
  Finnhub, Webull, and Robinhood; India uses its market-local calendar/Yahoo
  source. A disagreement beyond one market session is `conflict`.
- Robinhood read-only contract allowlist and owner/cron schema diagnostics.
  Order, review, cancel, account, and position tools are structurally excluded.
- Exact post-event expiry, bounded option-instrument pagination, nearest common
  call/put strike, timestamp/liquidity/spread validation, and an expiry-bounded
  ATM straddle move proxy. Yahoo is a labelled fail-soft shadow fallback.
- Paper entry and capital-rotation annotations before execution. The annotation
  cannot alter the atomic fill or rotation arguments.
- Live proposal annotation while preserving the existing Alpha Vantage
  `-2/+5` blackout exactly. No live execution code reads the annotation.
- Owner-facing Portfolio Risk panel with current-holding event warnings and
  acceptance-window counts. No raw option chain reaches the browser.
- Append-only `earnings_risk_observations` with owner-read RLS, service-only
  insert, immutable rows, retry idempotency, and database checks that pin
  `policy_mode='shadow'` and `behavior_changed=false`.
- Post-DDL advisor findings were resolved: the owner policy caches `auth.jwt()`
  through a scalar subquery and `proposal_id` has a covering partial index.

## Live Proof

The bounded AAPL probe on 2026-07-29 resolved the same 2026-07-30 AMC date from
the cache, Finnhub, Webull, and verified Robinhood calendar. It selected the
2026-07-31 expiry and the true $340 common strike, then normalized timestamped
Robinhood bid/ask, sizes, and open interest. The quote exceeded the 15-minute
freshness ceiling and was correctly classified `stale`; no counterfactual action
was treated as usable. Retrying the probe left one ledger row.

## Behavior Boundary

This release does not change scores, eligibility, sizing, stops, targets,
holding horizons, proposals, fills, rotations, or exits. Future activation
requires 60 otherwise-eligible US entry decisions, 20 distinct events, the
remaining calibration gates in `FEATURE_ARCHITECTURE.md`, and a separate owner
approval.

---

## Post-implementation review fix — 2026-07-29

Independent adversarial review of `65c1c5be`. All twelve stated review
priorities were checked; production DB invariants were verified against the live
database rather than the migration files.

### Finding 1 (MED, fixed) — `tradingSessionsBetween` fabricated session counts

Proven by execution against the shipped code:

| Input | Returned | Should be |
|---|---|---|
| `to = "not-a-date"` | **282** | unknown |
| `to = "2030-01-01"` (beyond the 400-iteration guard) | **282** | unknown |
| `to = ""` | **-280** | unknown |

The loop exited on its guard without signalling that the target was never
reached, returning whatever it had counted. Two reachable consequences:

1. `app/api/portfolio/earnings-risk/route.ts` computes `sessionsUntilReport`
   from a **persisted** `report_date`, so a malformed or far-future stored date
   rendered a fabricated "trading sessions until report" on the owner's Risk
   page.
2. The `conflict` check compared two such values. `Math.abs(null)` is `0`, and
   two unparseable dates each scored 282 — so they compared as **agreeing**,
   producing `status: "available"` from data whose distance could not be
   computed. That directly contradicts this feature's own rule that unknown or
   conflicting data must never become a confident date.

**Fix.** `tradingSessionsBetween` now returns `number | null`, rejects
non-ISO and impossible dates (`2026-02-31`) up front, and returns `null` when the
target is not reached inside the guard. The conflict check treats `null` as a
conflict rather than agreement. Both call sites already typed
`sessionsUntilReport` as `number | null`, so the unknown propagates without a
signature change at the boundary. Five regression assertions added.

No behavioural change to trading: the value was already shadow-only.

### Verified clean

- **Shadow isolation (paper):** `earningsRisk` appears at seven sites — one
  declaration, one assignment, two log fields, two record calls, one null guard.
  Never in arithmetic or a branch condition. The rotation observation sits inside
  the pre-existing `atNameCap || cashShort` branch and is `try`-wrapped.
- **Legacy live blackout:** AV fetch, CSV parse and `diffDays >= -2 && diffDays
  <= 5` unchanged. `skipped.push` and `continue` sit **after** the annotation's
  `try/catch`, so a throwing annotation cannot weaken the block.
- **False ATM under incomplete pagination:** guarded by
  `hasMore && maxStrike < spot -> return null`.
- **Read allowlist:** `callRobinhoodResearchReadTool` re-checks the name at
  runtime and returns `tool_not_allowlisted`, so a cast cannot bypass it.
- **Owner API:** `requireOwner()` gates on `OWNER_EMAIL` **and**
  `email_confirmed_at`; another authenticated user receives 403.
- **No raw payload to the browser:** the portfolio route selects an explicit
  column list containing no raw/chain/payload column.
- **Production DB (queried live, not inferred from migrations):**
  `policy_mode CHECK (= 'shadow')`, `behavior_changed CHECK (= false)`, RLS
  enabled, owner policy uses `(select auth.jwt())`, `authenticated` = SELECT
  only, `service_role` = SELECT + INSERT only (UPDATE and DELETE both return
  `42501`), `anon` no grants, plus a `BEFORE DELETE OR UPDATE` immutability
  trigger and 19 domain CHECKs.

### Open, not fixed

- **Quota/latency (LOW, not a defect):** the annotation is awaited inline before
  sizing on every paper entry. The Robinhood calendar is cached 30 minutes, but
  `get_option_chains`, `get_option_instruments` (up to 5 sequential pages) and
  `get_option_quotes` are not. Fail-soft, so it cannot break a fill, but it adds
  real latency and broker quota per entry.
- **Provider parsers (priority 3): partially verified.** Numeric coercion and
  `null` returns are correct on the paths read; not every provider parser was
  exhaustively audited.
