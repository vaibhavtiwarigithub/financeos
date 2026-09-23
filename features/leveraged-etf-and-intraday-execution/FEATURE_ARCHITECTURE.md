# Leveraged ETF Sleeve and Intraday Execution Architecture

## L4 implemented, then flags decoupled at enable time — 2026-09-23 (same day as approval)

The L4 section below was implemented same-day (see docs/arch/03-agents.md and
05-crons-and-scheduling.md for the code inventory: `app/api/agents/
leveraged-live/cron/route.ts`, `lib/trading/leveraged-live-kernel.ts` /
`leveraged-live-entry.ts` / `leveraged-sleeve-risk-live.ts`,
`leveraged_live_positions` table). At the moment the owner set the lease
($250, then revised to **$50**) and asked to "flip the rest and enable it
now," a real problem surfaced: the gate originally reused `AUTONOMOUS_LIVE_
ENABLED` (env) and `strategy_config.live_auto_enabled` (DB) — the SAME two
flags core-equity `AutonomousLive` uses. Flipping both, as literally asked,
would have silently enabled autonomous live trading for the entire equity
book too, not just this $50 leveraged sleeve — a completely separate,
much larger, never-fired system. This was caught and raised before
executing, not after.

**Resolution — decouple, don't share:** new independent flags,
`LEVERAGED_LIVE_ENABLED` (env, `lib/autonomy.ts`) and `strategy_config.
leveraged_live_auto_enabled` (DB, migration `20260923030000`). Core-equity
`AutonomousLive`'s own `AUTONOMOUS_LIVE_ENABLED`/`live_auto_enabled` are
untouched — exactly as dormant as before this feature existed.
`PROTECTIVE_PLACEMENT_WORKER_AVAILABLE` remains a genuinely shared
constant (it is the master kill switch for ANY broker-side stop placement
in this codebase, not leveraged-sleeve-specific) — its blast radius is
currently contained in practice because nothing else calls
`placeProtectiveStop()` yet except this leveraged-live cron; flagged here,
not hidden, in case that changes later.

**Settings UI added** (`app/api/settings/leveraged-live/route.ts`,
`components/dashboard/LeveragedLiveSettings.tsx`) so live status for the
leveraged sleeve is visible and controllable in the same place as
everything else — a separate panel from the existing "Autonomous Trading"
(core-equity) panel, showing all five gates' current state, the lease
amount (editable), the shared `protective_orders_enabled` toggle (labeled
as shared), and enable/disable with a typed confirmation
(`"ENABLE LEVERAGED LIVE"`), mirroring the core-equity panel's own pattern.

**Current state (2026-09-23):** `leveraged_sleeve_live_lease_usd=50`,
`leveraged_live_auto_enabled=false`, `protective_orders_enabled=false`,
`LEVERAGED_LIVE_ENABLED` unset (false), `PROTECTIVE_PLACEMENT_WORKER_
AVAILABLE=false`. Still fully inert — the lease alone does not enable
anything; the owner has not yet flipped the remaining flags.

## L4: live trading for SOXL/TQQQ/SQQQ/SOXS + SQQQ/SOXS paper doors — proposal 2026-09-23 (AWAITING APPROVAL, NOT IMPLEMENTED)

Owner (2026-09-23, same day as the TQQQ paper approval above): "Paper and live
trading for th[ese, all four symbols] needs to be enabled... dont push back
enable now," then, asked directly, confirmed via structured choice: live
trading for **all four** — SOXL, TQQQ, SQQQ, **and SOXS** — and asked for this
proposal to be drafted immediately for review.

This reverses two standing decisions on the record, and that reversal is
being stated plainly rather than absorbed silently:
1. SQQQ/SOXS move from "shadow-only, not up for reconsideration" (this
   file's section above, written hours earlier) to approved-for-a-live-and-
   paper build. The owner's own words override that line explicitly.
2. `lib/trading/symbol-policy.ts`'s blanket leveraged/inverse block, which
   this file has repeatedly called "off-limits to touch as a shortcut," gets
   a **named, narrow carve-out** for these four symbols on ONE dedicated
   path only (below) — the block itself, and its effect on every other path
   (research, the generic Execution Gateway, PaperTrader), is unchanged.

### What "enable now" actually requires — read before approving

A live survey of this codebase (2026-09-23) found — **and this section was
corrected the same day** after finding code the first pass missed:

- **No live order has ever been placed autonomously for anything in this
  app.** `AutonomousLive`'s 9-gate kernel and Kelly sizing are built and
  code-complete, but the deployment flag `AUTONOMOUS_LIVE_ENABLED` is false
  in production — it has never fired. The only live order this system has
  ever sent was one **manual, human-clicked** Robinhood order on 2026-07-07
  (`features/live-trading-hardening/FEATURE_ARCHITECTURE.md`).
- **CORRECTED: a broker-native protective stop already exists, built and
  gated off — this proposal's first draft wrongly said none did.**
  `lib/protective/placement-worker.ts`'s `placeProtectiveStop()` calls
  `placeRobinhoodGtcStop()` (`lib/robinhood-mcp.ts`), which places a real
  GTC stop-market order at Robinhood via the vault-stored, auto-refreshing
  OAuth token the same MCP path already uses for the one live order this
  system has sent — no live interactive session required, contrary to the
  first draft's claim. It's backed by a declared broker capability matrix
  (`lib/protective/robinhood-capabilities.ts`: RH GTC stop-market, regular
  session only, cancel-replace to update, no documented lifetime cap),
  full reconcile/cancel logic, idempotent placement via correlation IDs,
  and an event log (`protective_orders`/`protective_order_events`). It is
  currently inert behind two false-by-default gates: the source-level
  constant `PROTECTIVE_PLACEMENT_WORKER_AVAILABLE` in
  `lib/protective/coverage.ts`, and `strategy_config.protective_orders_enabled`.
  See `features/hybrid-stop/FEATURE_ARCHITECTURE.md` for its own approval
  history — its header still reads "deliberately unimplemented," which is
  now stale relative to the code; `placement-worker.ts` is the P2 placement
  work that doc's own "Build Order After Approval" step 5 describes, already
  written.
- **This changes the shape of the work, not the safety bar.** Equity
  leverage (SOXL/TQQQ/SQQQ/SOXS) does not need a new stop-placement
  mechanism built — it needs the EXISTING worker reused (part 3, rewritten)
  and its two flags flipped, scoped to the leveraged sleeve. Crypto is
  unaffected by this correction: Robinhood's declared capability matrix has
  no crypto entry at all, so crypto's stop-order question (part 8) is
  exactly as open as the first draft said.
- Every other fact from the first draft stands: no live order has ever
  fired autonomously for anything in this app, so leveraged/inverse
  instruments would still be the first live-fire of the whole autonomous
  path, on instruments (SQQQ/SOXS) with zero paper track record. That risk
  doesn't disappear because the stop mechanism turns out to already exist
  — it just means the remaining work is wiring and testing an existing,
  reviewed component instead of building and reviewing a new one.

### 1. Reuse existing live machinery — do not build a parallel stack

Everything below already exists, dormant, and is reused unchanged:

| Piece | File | Reused as |
|---|---|---|
| Multi-broker order lifecycle | `app/api/broker/orders/route.ts`, `lib/brokers/registry.ts` | The live order path for the new leveraged-sleeve door |
| 9-gate authorization kernel | `lib/trading/execution-kernel.ts` (`evaluateAutonomousExecution`) | Gates every live leveraged fill, same 9 checks (lease, policy version, flags/token/allowlist, kill switches/alerts, proposal freshness, fresh NAV/positions, qty validation, cap minimum, portfolio limits) |
| Kelly sizing | `computeAutonomousSizing` | NOT reused for the leveraged sleeve — see part 4; a fixed small lease replaces Kelly here deliberately |
| Shared exit decision core | `lib/trading/exit-ladder.ts` (`decideExitLadder`) | Same function paper SOXL/TQQQ already use — live cannot diverge from paper's protective logic by construction |
| Order/account infra | `broker_orders` table, `605420660` allowlist (`broker_accounts`, migration 093) | Unchanged; the leveraged sleeve places orders through the SAME allowlisted account, no new account |
| Deployment + DB dual gate | `AUTONOMOUS_LIVE_ENABLED` (env) AND `strategy_config.live_auto_enabled` (DB) | Both still required; a THIRD gate is added below, specific to the leveraged sleeve |
| **Broker-native protective stop** | `lib/protective/placement-worker.ts` (`placeProtectiveStop`/`cancelProtectiveStop`), `lib/robinhood-mcp.ts` (`placeRobinhoodGtcStop`) | Reused unchanged (part 3) — a real, already-built GTC stop-market placement, not new code |

No new broker adapter, no new account, no new order table, and — corrected
from this proposal's first draft — **no new stop-placement mechanism**.

### 2. The narrow symbol-policy carve-out

`isSymbolBlocked()` in `lib/trading/symbol-policy.ts` is NOT relaxed
generally. A new optional parameter is added:

```ts
export async function isSymbolBlocked(
  svc: SupabaseClient, symbol: string, market: "us" | "india",
  opts: { failClosed?: boolean; leveragedSleeveCaller?: boolean } = {},
): Promise<{ blocked: boolean; reason?: string }>
```

When `leveragedSleeveCaller` is true AND the symbol is one of exactly
`SOXL`/`TQQQ`/`SQQQ`/`SOXS`, the leveraged/inverse check is skipped (DB
blocklist check still applies — an owner blocklist entry still wins). Every
existing caller (research candidate selection, PaperTrader, the generic
Execution Gateway, the generic paper path) passes no such option and is
completely unaffected — this is checked by a new test asserting the default
(no option) behavior is byte-for-byte unchanged. Only the NEW leveraged-
sleeve live route (part 3) and its paper-door siblings (part 5) pass
`leveragedSleeveCaller: true`. This is the entire scope of the symbol-policy
change — four named symbols, one named caller class, nothing else moves.

### 3. Broker-native protective stop — REUSE the existing worker, don't build a new one

**Corrected from this proposal's first draft.** `lib/protective/placement-
worker.ts`'s `placeProtectiveStop()` already does everything part 3
originally proposed building: places a real Robinhood GTC stop-market after
a confirmed fill, records it in `protective_orders`, and `cancelProtective
Stop()` cancels it before an explicit SELL. No new order-placement code is
needed for equities.

Sequencing for every live leveraged fill, using the EXISTING worker:
1. Submit the entry as a market order through the existing Execution
   Gateway/`605420660` path (unchanged).
2. On confirmed fill, call `placeProtectiveStop()` with the fill qty/price
   and `market: "us"`. It internally evaluates broker eligibility via
   `evaluateProtection()` against `ROBINHOOD_PROTECTIVE_CAPABILITIES`,
   computes the stop price, inserts a `protective_orders` row
   (`status: "placing"`), places the real GTC stop-market, and marks it
   `active` on confirmation — or `failed` if the broker rejects it.
3. If `placeProtectiveStop()` returns `ok: false` (not `skipped` — a
   `skipped: true` means the flags are still off, which should never
   happen once this door is live-enabled, and is itself worth alerting on
   if seen), **do not leave the position naked**: immediately submit a
   market SELL to flatten the just-opened position, log a critical
   `agent_alerts` row, and stop. A failed protective stop is treated as a
   failed entry, not a "we'll retry the stop later" — every other
   protective mechanism in this codebase (SOXL/TQQQ paper, the
   semiconductor/sleeve caps) fails closed the same way.
4. Every subsequent live-exit-monitor cycle (part 6) reconciles against
   `protective_orders.status`: if it's not `active` (cancelled externally,
   filled, broker-side error, or stuck in `needs_reconcile` from a failed
   cancel), the SAME fail-closed flatten in step 3 fires rather than
   leaving a silently-unprotected position running until the next
   scheduled check. `cancelProtectiveStop()` is called before any explicit
   SELL from the exit ladder, to avoid a double-sell race against the
   resting broker stop.

**Two flags to flip, scoped narrowly:**
- `PROTECTIVE_PLACEMENT_WORKER_AVAILABLE` (source constant in
  `lib/protective/coverage.ts`) is currently a blanket `false` gating this
  worker for ALL live positions, not just the leveraged sleeve — flipping
  it to `true` is a real, session-wide change in blast radius, not a
  leveraged-sleeve-scoped one, since core-equity `AutonomousLive`'s own P1
  interlock (`features/hybrid-stop/FEATURE_ARCHITECTURE.md`) reads the same
  constant. This is safe today ONLY because `AUTONOMOUS_LIVE_ENABLED`
  (core equity) is independently still `false` — but it means flipping this
  constant is itself a decision with scope beyond this proposal, worth the
  owner's explicit attention, not a rubber-stamp inside the leveraged-sleeve
  approval. Recommend: keep the constant `true` permanently once flipped
  (it's source-level, not a live toggle) and rely on `strategy_config.
  protective_orders_enabled` (DB) plus the leveraged-sleeve's own 10th gate
  (part 6) as the actual live controls.
- `strategy_config.protective_orders_enabled` (DB) is the operational
  on/off switch — flip this when ready to test, unflip to kill protective
  placement instantly without a redeploy.

**What's genuinely still missing, not a correction of the above:** the
entry-fill sequence (step 1-2) that CALLS `placeProtectiveStop()` after a
leveraged-sleeve fill doesn't exist yet — that's real new code (part 6),
just orchestration around an existing primitive, not a new broker
integration.

### 4. Lease size — fixed, small, NOT Kelly-sized, NOT the paper 5%

The paper sleeve's 5%-of-$10k-NAV cap ($500 notional headroom, combined
SOXL+TQQQ) is a paper-experiment risk envelope, not a live-money
recommendation — it was sized to make paper learning meaningful, not to
survive a live gap on a 3x fund with zero live track record. For live:

- A NEW, separate, fixed-dollar lease — **not** a percentage of live NAV,
  **not** Kelly-sized (Kelly sizing assumes a validated edge; none exists
  yet for any of these four instruments, they have zero or (for TQQQ) a
  handful of paper cycles) — owner sets the number explicitly before this
  ships; this proposal recommends starting at $100–$250 total, combined,
  across all four symbols, specifically because it is small enough that a
  worst-case total loss is a rounding error, not a real financial event,
  while the live pipeline (fill → stop → reconcile) proves itself.
- The combined-sleeve accounting from the paper cap
  (`leveraged-sleeve-risk.ts`) is reused conceptually but reads LIVE
  positions/NAV via `broker_orders`/`live_position_state`, not
  `paper_positions` — a new `lib/trading/leveraged-sleeve-risk-live.ts` thin
  wrapper, same headroom math, different data source. Paper and live
  leverage exposure are never summed together.

### 5. SQQQ/SOXS get paper doors first — same pattern as SOXL/TQQQ

Before either gets a live door, they get what SOXL/TQQQ already have:
`lib/trading/sqqq-lifecycle.ts` / `soxs-lifecycle.ts` (mirrors `tqqq-
lifecycle.ts` exactly — same `decideExitLadder` reuse; buying shares of an
inverse ETF is an ordinary long position in that instrument, not a short
sale, so the existing long-only exit ladder applies unchanged), `execute_
sqqq_paper_fill` / `execute_soxs_paper_fill` RPCs (`position_role=
'sqqq_paper'`/`'soxs_paper'`), dedicated cron doors with their own ET
windows (11:40–11:54 and 12:00–12:14, continuing the 15-minute offset
pattern from SOXL/TQQQ), capacity via the SAME shared
`leveragedSleeveHeadroom()` (now genuinely four-way combined, still 5% of
paper NAV total). `leveraged-etf-shadow.ts` already observes these two; the
paper doors are the only new paper-side work.

**Recommended (not mandatory) sequencing gate:** a symbol needs at least 10
closed paper trades with `resolveDecisionContext`-clean evidence before its
live door is allowed to fire, mirroring the LearnerAgent's own "10+ closed
trades before Phase 1" rule elsewhere in this codebase. SOXL/TQQQ can likely
clear this within days; SQQQ/SOXS start at zero today. This is a default in
the code (a `min_paper_trades_before_live` check per symbol in the 9-gate
kernel extension, part 6), not a hard block — the owner can override it
per-symbol via the same `strategy_config` flags that gate everything else
here, consistent with how every other override in this codebase works
(explicit, logged, reversible), not a silent bypass.

### 6. Live leveraged-sleeve door

New `app/api/agents/leveraged-live/cron/route.ts`, one route for all four
symbols (unlike the paper doors' one-route-per-symbol pattern — live's
extra gating makes a shared route with a symbol loop the better shape here,
since every symbol goes through the identical 9-gate-plus-stop-
reconciliation sequence). Entry windows reuse each symbol's existing paper
window (11:00/11:20/11:40/12:00 ET) so live and paper evaluate the same
signal at the same moment for comparison. Per symbol, per run:

1. `evaluateAutonomousExecution` (existing 9-gate kernel) — unchanged gates,
   PLUS the new `min_paper_trades_before_live` check (part 5) as a 10th
   gate, PLUS `leveragedSleeveCaller` symbol-policy carve-out (part 2).
2. If held: reconcile the broker-side stop (part 3, step 5); on a real
   stop/target hit, submit the live exit through the existing Execution
   Gateway.
3. If flat and all gates pass: the SAME entry-planning logic each paper
   lifecycle module already computes (`planTqqqEntry`-shaped output) sizes
   against the LIVE lease headroom (part 4) instead of the paper cap, then
   executes the market-fill-then-stop sequence (part 3).
4. Every decision — gate pass/fail per gate, fill, stop placement,
   reconciliation outcome — is written to `broker_orders` /
   `live_position_state` with the same fields `LiveExitMonitor` already
   uses, so this door is visible in the exact same places the dormant
   equity live path would be, not a separate invisible pipeline.

### 7. Acceptance criteria

- `AUTONOMOUS_LIVE_ENABLED=false` (or `live_auto_enabled=false`) makes this
  entire route a no-op, identical to every other live path today.
- No live order for these four symbols can be submitted without a
  confirmed, broker-resting protective stop within the bounded window; a
  failed stop always flattens rather than leaves a naked position.
- `isSymbolBlocked()`'s default behavior (no `leveragedSleeveCaller` option)
  is unchanged for every existing caller — enforced by a new test.
- Live and paper leveraged notional are never summed into one cap; each has
  its own headroom check against its own data source.
- A symbol below `min_paper_trades_before_live` cannot fire live unless the
  owner explicitly overrides that symbol's flag — the override itself is
  logged (who, when, which symbol) the same way every other manual override
  in this codebase is.
- Combined live leveraged-sleeve exposure across SOXL/TQQQ/SQQQ/SOXS never
  exceeds the owner-set lease (part 4).

### 8. Crypto (BTC/ETH/SOL), US-only — same broker-native-stop rule, bigger gap to close

**Resolved, same day (2026-09-23).** The capability question below was
answered with real evidence, not assumption: extended the existing
`crypto-capability-probe` route to surface `place_crypto_order`'s declared
property key names (never the full schema — see the probe's own "persist
hashes, not untrusted schemas" rule). Triggered it live twice (once for an
enum check that came back inconclusive, once for the property-key check
that settled it): the schema genuinely has a `stop_price` field, alongside
`quantity`, `side`, `symbol`, `type`, `time_in_force`, `rhs_account_number`.
Crypto live trading is buildable under the no-live-order-without-broker-
native-stop rule and was built the same day:
`app/api/agents/crypto-live/cron/route.ts`, `lib/trading/crypto-live-
kernel.ts`/`crypto-live-entry.ts`, `placeRobinhoodCryptoOrder` in
`lib/robinhood-mcp.ts`. Unlike the leveraged sleeve, crypto's flags
(`CRYPTO_LIVE_ENABLED`, `strategy_config.crypto_live_auto_enabled`,
`crypto_live_lease_usd`) were decoupled from every other book FROM THE
START — the leveraged sleeve only got there after a near-miss at enable
time; crypto had the benefit of that lesson already learned. See
`docs/arch/03-agents.md`'s "Crypto live trading (L4)" section for the full
design record. The paragraph below is preserved as the original open
question, for the record.

Owner (2026-09-23, clarifying "including crypto"): the broker-native-stop
requirement applies to **every symbol traded live in both pipelines** —
equities/leveraged AND crypto — with no exception. Crypto has no India
counterpart (confirmed by owner) — `market='crypto'` stays its own pool, as
it already is in paper.

This is not a small addition to part 3's pattern. Crypto starts from a
materially emptier position than the equity leveraged sleeve did:

- **No live crypto order execution path exists at all today**, anywhere in
  this codebase. `lib/brokers/robinhood/rest-client.ts` (the serverless-safe
  adapter `AutonomousLive`/cron paths use) is equities-only — no
  `rhPlaceCryptoOrder` function exists. The crypto research/paper pipeline
  (`CryptoPaperTrader`, `crypto-position-monitor`) never calls a broker at
  all; it is a pure internal ledger. The Robinhood MCP path
  (`lib/brokers/crypto-capability.ts`, `place_crypto_order` /
  `preview_crypto_order` / `cancel_crypto_order`) is capability-DETECTION
  only (does the connected account's MCP session currently advertise these
  tools) — it has never been called to submit a real order. **Correction**
  (found while fixing part 3's stop-mechanism error): the MCP path does NOT
  actually need a live interactive session — `placeRobinhoodGtcStop` in
  `lib/robinhood-mcp.ts` already places real equity stop orders serverless,
  via a vault-stored, auto-refreshing OAuth token (`getValidAccessToken`),
  the exact same mechanism this system's one real live order used. So a
  `place_crypto_order` call COULD run from a cron the same way — the actual
  gap is narrower than first stated: nothing has ever CALLED
  `place_crypto_order` for real, and its accepted parameters (does it take
  a stop type at all) are unverified, but the serverless-session objection
  from the first draft was wrong and is retracted.
- **Whether Robinhood crypto orders even support a stop order type is
  UNVERIFIED.** Nothing in this codebase currently records the accepted
  parameters of `place_crypto_order` (order type enum, whether `stop_price`
  is a supported field). Many retail crypto venues support market/limit
  only, no native stop. This must be confirmed against the actual tool
  schema (or Robinhood's crypto API docs directly) BEFORE any other crypto-
  live work starts, because it determines whether this is buildable at all
  under the owner's own non-negotiable (part 3: no live order without a
  confirmed broker-resting protective stop; a failed stop always flattens,
  never left naked). **If Robinhood crypto has no native stop order type,
  crypto live trading does not ship** until either Robinhood adds one or a
  different venue with native crypto stops is used — there is no app-side-
  polling fallback for crypto, same as equities.
- Crypto is 24/7; the equity leveraged sleeve's ET entry-window pattern
  (part 6) doesn't transfer directly. A crypto live door needs its own
  session model — likely closer to `LiveExitMonitor`'s continuous-cadence
  reconciliation than the equity sleeve's narrow windows — designed once the
  order/stop capability question above is answered, not before.

**Sequencing:** the crypto broker capability question (stop-order support)
gets verified FIRST, as its own short, scoped investigation, before any
crypto-live design work continues. If the answer is "yes, supported,"
part 3's pattern (fill → confirm → stop → reconcile → fail-closed flatten)
extends to crypto with a new `rhPlaceCryptoStopOrder`-equivalent and its own
lease (part 4's fixed-dollar approach, sized separately from the equity
leveraged sleeve — never summed with it). If "no," this section is blocked
and says so rather than shipping a weaker protection for crypto than for
equities.

### 9. Explicit non-goals

- No change to core-equity `AutonomousLive`'s own gates, lease, or Kelly
  sizing — this is a fully separate door reusing shared infrastructure, not
  a modification to the existing (still-dormant) equity live path.
- No margin, no options, no short sale of bare stock — SQQQ/SOXS remain
  ordinary long positions in inverse-tracking instruments.
- No relaxation of `symbol-policy.ts`'s block for any symbol outside these
  four, on any path outside the two named callers.
- Kelly sizing is explicitly NOT used for the leveraged sleeve at this
  stage (part 4) — flag if this should be revisited once real trade history
  exists.
- No India crypto — crypto stays US-only, its own pool, never summed with
  equity leverage or India.

**Status:** proposal only, drafted per explicit owner request. Implementation
requires (a) the owner setting the actual lease dollar amount(s) (part 4,
and separately for crypto per part 8), (b) verifying Robinhood crypto's
stop-order capability (part 8) before crypto-specific work proceeds, and
(c) an explicit "Approved" / "Proceed" on this specific section, per this
project's Architecture-First Mode — the same gate every prior phase in this
file went through, now applied to a live-money change instead of a paper
one.

## TQQQ paper sleeve + SQQQ/SOXS shadow-only + GLD/SLV deferral — proposal 2026-09-23 (AWAITING APPROVAL, NOT IMPLEMENTED)

Owner asked (2026-09-23): "similar to SOXL i want the app to learn and become
best at trading TQQQ, SQQQ and also SOXS... leveraged in total cannot be more
than 5% of entire portfolio ever. GLD, SLV should be around 10-15%... when the
time is right", then "should we research leveraged ones 4 symbols... each day
to see if they should be bought or not? and also traded since... jump a lot at
once."

Answer to the "research vs trade cadence" question: split them. Research
(score/classify) can run daily for all names — cheap, no reason to throttle.
Trading stays gated by a dedicated per-instrument door with a fixed narrow
entry window, exactly like SOXL — "it moves fast" is the argument for a
same-day monitor check (already shipped for SOXL, 2026-09-23, commit
`11bbe427`), not for more frequent entries or a shared execution engine.

### Decision

| Symbol | Research | Paper trading |
|---|---|---|
| TQQQ | Own door (dedicated cron), same pattern as SOXL | **Yes** — new dedicated door, L2 like SOXL |
| SOXL | Already live (L2, approved 2026-09-22) | Already live — unchanged by this proposal |
| SQQQ | Shadow-only (`leveraged_etf_shadow_observations`) | **No** — inverse fund, standing refusal (`symbol-policy.ts`'s block; CLAUDE.md push-back mandate). Not up for reconsideration by this proposal. |
| SOXS | Shadow-only | **No** — same reason as SQQQ |
| GLD | Unchanged (already tradable as an ordinary ETF, no leverage) | Deferred — regime-tied sizing (10–15%) needs the macro-regime/breadth-shadow Phase 1 evidence review, which is weeks away and out of scope here |
| SLV | Unchanged | Deferred, same reason as GLD |

This is additive to the existing L0–L4 phased model above, not a
replacement. TQQQ enters at **L2 (isolated paper sleeve)** directly, mirroring
SOXL's own L2, because L0/L1 groundwork (instrument classification via
`symbol-policy.ts`'s block + `leveraged-etf-shadow.ts`'s already-approved
`TQQQ` shadow entry, quote-quality contract, market-local window policy) is
already built and shared with SOXL — there is no separate L0/L1 phase to
repeat for TQQQ specifically.

### 1. Combined 5% ceiling (not 5% each)

The owner's rule is explicit and literal: "leveraged in total cannot be more
than 5% of entire portfolio ever." SOXL's own ceiling amendment (2026-09-22,
above) already set SOXL's *individual* ceiling to 5% of NAV — if TQQQ also
got its own independent 5%, the two together could reach 10%, violating the
owner's rule. So TQQQ does **not** get its own 5% envelope. Instead:

```
leveraged_sleeve_headroom = max(0, nav * 0.05 - sum(marketValue of every
  open soxl_paper/tqqq_paper position))
```

New pure module `lib/trading/leveraged-sleeve-risk.ts`:

```ts
export const LEVERAGED_SLEEVE_MAX_NAV_FRACTION = 0.05; // shared SOXL+TQQQ ceiling
export interface LeveragedSleevePosition { symbol: string; marketValue: number }
export function leveragedSleeveHeadroom(input: {
  nav: number; positions: LeveragedSleevePosition[];
}): { ok: true; headroom: number } | { ok: false; reason: string };
```

Both `soxl-lifecycle.ts`'s `planSoxlEntry` and the new `tqqq-lifecycle.ts`'s
`planTqqqEntry` clamp `maxNotional` to
`min(existing-instrument-specific-cap, leveragedSleeveHeadroom(...).headroom)`
before returning a plan. `semiconductor-risk.ts`'s existing SOXL-specific
25%-of-NAV semiconductor concentration cap is untouched — it is a *different*
constraint (sector exposure, not the leveraged-sleeve ceiling) and stays in
place unchanged. No new sector-concentration cap is invented for TQQQ/Nasdaq
exposure — the owner did not ask for one, and the codebase does not have one
for the general ETF path either (ponytail: skip speculative rule; add if the
owner asks after seeing real overlap in practice).

A read failure on NAV or the open-position list is a money-path denial
(`headroom` computation fails closed), matching every existing cap in this
file.

### 2. TQQQ dedicated door (mirrors SOXL exactly)

New files, one-for-one mirrors of the SOXL equivalents — this codebase's
established pattern is one isolated door per instrument, not a shared engine
(see "isolated experiment lineage," section 6 above); a third instrument
would be the point to consider merging, not the second:

| SOXL | TQQQ (new) |
|---|---|
| `lib/trading/soxl-lifecycle.ts` (`planSoxlEntry`, `monitorSoxl`) | `lib/trading/tqqq-lifecycle.ts` (`planTqqqEntry`, `monitorTqqq`) — same shape, same `decideExitLadder` reuse, clamps to `leveragedSleeveHeadroom` instead of `semiconductorCapacity` |
| `lib/trading/soxl-evidence.ts` (`soxlEntryWindow`, `soxlQuoteTime`) | `lib/trading/tqqq-evidence.ts` — same 15-minute quote-freshness rule; entry window **11:20–11:34 ET** (15 min after SOXL's 11:00–11:14, so the two never contend for the same cron minute; the shared pool-row lock in the RPC would serialize them safely either way, but there is no reason to make them race) |
| `execute_soxl_paper_fill` RPC, `position_role='soxl_paper'` | `execute_tqqq_paper_fill` RPC, `position_role='tqqq_paper'` — identical shape, `p_symbol <> 'TQQQ'` guard. Exits reuse `execute_paper_exit` unchanged (already position-role-generic), same as SOXL. |
| `app/api/agents/soxl/cron/route.ts` | `app/api/agents/tqqq/cron/route.ts` — same monitor/entry branch structure, same `agent_runs`-based liveness proof (`agent_type='tqqq_cron'`), same **twice-daily cadence from day one** (entry+mid-day window ~11:20 ET, after-close monitor ~16:20 ET) — SOXL only got the after-close check after a gap was found post-launch; TQQQ ships with it already, since the gap class is now known. |
| `vercel.json`: 4 SOXL cron entries (EDT/EST × entry-window/after-close) | 4 new TQQQ entries, same EDT/EST pairing, offset by ~15/5 min from SOXL's |

Entry qualification for TQQQ mirrors SOXL's: trend-qualified on TQQQ's own
candles (`priceVsEma20`/`priceVsEma50`/`trend20d`, `detectBreakdownVeto`),
ATR-based stop/target, swing-low structural stop, liquidity floor via
`computeLeveragedShadowFeatures` (already symbol-agnostic, reused as-is, no
change needed), completed-session candle evidence, fresh-signal-after-exit
guard. No LLM in the decision path, matching the "no LLM may decide
eligibility, size, stop, target" rule in section 4 above.

### 3. TQQQ↔SOXL correlation — measured, not gated

The owner asked to "understand relationship between these." `leveraged-etf-
shadow-features.ts` already computes independent per-symbol vol/trend/ATR;
add one new pure function, `correlation20d(returnsA, returnsB)` (Pearson,
trailing 20 sessions of daily returns), called once per collector run over
TQQQ's and SOXL's own candle series, and store the result on both symbols'
shadow observation row (`features.correlation_to_soxl_20d` /
`features.correlation_to_tqqq_20d`). This is informational, matching the
existing shadow table's `decision` CHECK-locked to `observe_only` — it does
**not** gate or size either instrument's entries. The 5% aggregate cap in
part 1 already protects against duplicate-factor risk regardless of measured
correlation (a hard ceiling that doesn't need the correlation number to be
right); using the correlation number to gate would be exactly the kind of
"claim of alpha before the evidence exists" rule 6 (evidence and promotion)
above warns against.

### 4. SQQQ/SOXS — shadow observation only, no trade door, ever

Per the owner's own standing instruction (`symbol-policy.ts`'s inverse block)
and CLAUDE.md's push-back mandate ("Removing SELL signal capability... any
feature that adds agent complexity" is gated, and inverse funds are excluded
by name in the original SOXL spec), SQQQ/SOXS get **research only, in the
already-existing shadow-observation sense** — not a new capability, not a
step toward trading them:

- Migration widens `leveraged_etf_shadow_observations`'s two CHECK
  constraints: `symbol in ('TQQQ','SOXL','SQQQ','SOXS')`,
  `underlying_symbol in ('QQQ','SOXX')` (SQQQ/SOXS share the same
  underlyings as TQQQ/SOXL — inverse, not a different index).
- `leveraged-etf-shadow.ts`'s `LEVERAGED_LONG_SHADOW_UNIVERSE` becomes
  `LEVERAGED_SHADOW_UNIVERSE` with an added `direction: "long" | "inverse"`
  field; `LeveragedShadowSymbol` widens to include `SQQQ`/`SOXS`. The
  collector route's `for` loop already iterates
  `Object.keys(LEVERAGED_...UNIVERSE)`, so it picks the two new symbols up
  with no route change.
- No RPC, no cron door, no lifecycle module, no `symbol-policy.ts` change —
  that file's blanket leveraged/inverse block is explicitly off-limits to
  touch as a shortcut (standing instruction) and this proposal does not need
  to touch it; the shadow path was always separate from that gate.
- Rename `decision: "observe_only"` stays exactly as-is; nothing about SQQQ/
  SOXS's observation record differs in kind from TQQQ/SOXL's, only in that no
  execution path exists to ever consume it.

### 5. GLD/SLV — explicitly out of scope this round

No code changes. They already trade through the ordinary (non-leveraged) US
ETF path today if and when the normal screener selects them — nothing here
changes that. The owner's "10-15% when the time is right" ask is a
regime-conditional *sizing target*, not a leverage question, and depends on
the macro-regime/breadth-shadow Phase 1 evidence review (`market-breadth`,
`global-spillover` collectors, both still accumulating data, per the
project's own evidence-before-formula-change rule in CLAUDE.md's Scoring
Data-Truth Review Protocol). Revisit after that review, not as part of this
leveraged-sleeve change.

### 6. Acceptance criteria (additive to section 8 above)

- SOXL + TQQQ combined open paper notional can never exceed 5% of US paper
  NAV at decision time; a NAV/position-list read failure denies the TQQQ
  entry (fails closed), same as every existing cap.
- TQQQ's own entry/monitor/exit path never touches `paper_positions` rows
  with `position_role` other than `tqqq_paper`; SOXL's path is unchanged.
- SQQQ/SOXS can reach `leveraged_etf_shadow_observations` with
  `decision='observe_only'` and nothing else — no code path from either
  symbol can produce a score, candidate, paper fill, or order. This is
  enforced structurally (no RPC/cron exists for them), not by a runtime
  check that could be bypassed.
- Correlation figures are stored, visible, and never read by any sizing or
  gating function.
- No change to `symbol-policy.ts`, `execute_paper_fill`, the live execution
  gateway, GLD/SLV's existing ordinary-ETF eligibility, or any core-equity
  LearnerAgent path.

### 7. Implementation checklist (post-approval)

1. `lib/trading/leveraged-sleeve-risk.ts` + test.
2. `lib/trading/tqqq-lifecycle.ts` + `tqqq-evidence.ts` + tests (mirror
   `soxl-lifecycle.test.ts` / `soxl-evidence.test.ts`).
3. Migration: `position_role` CHECK += `tqqq_paper`; `execute_tqqq_paper_fill`
   RPC; widen `leveraged_etf_shadow_observations` symbol/underlying_symbol
   CHECKs for SQQQ/SOXS. Apply via Supabase MCP, verify applied before any
   code ships that depends on it (per CLAUDE.md's schema-migration rule).
4. `lib/trading/leveraged-etf-shadow.ts`: widen `LeveragedShadowSymbol`,
   rename universe const, add `direction` field, add `correlation20d` to
   `leveraged-etf-shadow-features.ts`, wire into the collector route.
5. `app/api/agents/tqqq/cron/route.ts`, mirroring `soxl/cron/route.ts`.
6. `vercel.json`: +4 TQQQ cron entries.
7. `docs/arch/03-agents.md` (new agent/cron) + `public/agent-diagrams/system-map.json`
   (new TQQQ node + shadow SQQQ/SOXS edges) in the same commit — required by
   this repo's own "arch chapters every feature" rule.
8. Full verification cycle (tsc, full suite, real `next build`), commit,
   push, confirm Vercel `READY` via MCP — same standard as every change this
   session.

**Status:** proposal only. No implementation has started. Awaiting explicit
approval ("Approved" / "Proceed" / "Code it" / "Implement this" / "Yes, build
it" / "Apply this architecture" / "Approved, implement") per this project's
Architecture-First Mode before any of the above is written.

## Safety review follow-up — 2026-09-22 (local, not deployed)

The dedicated caller must not substitute last prices for missing bid/ask, fetch
timestamps for provider observations, or invocation time for monitor proof.
Entry now uses completed daily evidence, the exchange-local 11:00–11:14 window,
and refuses unknown semiconductor classifications. Re-fetching an old daily
setup does not authorize post-exit re-entry. Durable sleeve-specific monitor
proof is still absent, so entries refuse rather than claim readiness. Existing
generic protective monitoring has not been removed. Transactional cap enforcement,
single monitor ownership, fresh thesis exits, provider quote qualification and
production deployment remain pending; this is containment, not full activation.

## `leveraged_etf_shadow_observations` deployed — 2026-09-22

The table backing `app/api/agents/leveraged-etf-shadow/route.ts` did not exist in
production (`to_regclass` returned null; no migration created it, despite
`lib/trading/leveraged-etf-shadow.ts` and the route being committed 2026-08-03).
The route was a dead end: every call 503'd `leveraged_etf_shadow_not_deployed`.
Migration `20260922000000_leveraged_etf_shadow_observations.sql` created it
(append-only, immutable-row triggers, `decision` CHECK-locked to
`observe_only`, no anon/authenticated grants — owner-gated route + service-role
client only, matching `user_broker_credentials`'s posture) and was applied and
verified in production. **Still open:** no cron and no caller populate it. The
route accepts a POST but nothing sends one — a data collector (real SOXL/TQQQ
quotes + underlying + realized vol/ATR14/trend20d/dollar volume at the
11:00–11:14 ET window) is unbuilt. Until that exists, "deployed" is true but
"collecting" is false.

## SOXL ceiling amendment — owner approved 2026-09-22

SOXL's individual paper allocation ceiling is now 5% of current US paper NAV,
superseding the 3% individual ceiling below for SOXL only. The aggregate leveraged
sleeve ceiling remains 5%. Cash, loss-budget sizing, and combined semiconductor
exposure can reduce the actual allocation. This does not alter live permissions.
The risk module records this amendment as semiconductor-paper-risk-v2.

## Owner authorization update — 2026-09-22

The owner approved implementing and activating automatic paper trading for SOXL
and SOXX with instrument-specific research, sizing, protection, and combined
semiconductor exposure accounting. This supersedes the earlier L0–L1-only
authorization for these two symbols. SOXX is an ordinary sector ETF; SOXL must
retain a distinct daily-reset leveraged policy. Existing L2 risk ceilings remain
the initial implementation envelope. This authorization does not establish an
empirical edge or grant live trading permission. TQQQ and inverse funds are not
included in this paper activation. Deployment status remains pending verification.

**Status:** APPROVED 2026-09-13 — L0–L1 implementation only; no paper or live execution
**Date:** 2026-07-26
**Scope:** US paper book first. India, live trading, inverse ETFs, options, and extended-hours trading are explicitly out of scope.

## 1. Decision

Kairos should not enable leveraged ETFs through the generic ETF path. A long leveraged
ETF is a distinct instrument class with a daily-reset return objective, path-dependent
multi-session results, and materially higher gap and execution risk. The correct first
product is an isolated, paper-only US sleeve that is disabled by default.

The proposed initial envelope is:

| Limit | Initial policy |
|---|---:|
| One leveraged ETF | 3% of US paper NAV |
| Entire leveraged ETF sleeve | 5% of US paper NAV |
| Number of leveraged ETF positions | 1 |
| Market | US / USD only |
| Direction | Long leveraged only |
| Default state | Disabled |

The 3% and 5% limits are ceilings, not target allocations. A 5% sleeve can lose its
entire paid value, or about 5% of the US portfolio at the entry-time NAV, if its
products go to zero; a 3x product also creates roughly 15% initial index-equivalent
exposure before path effects. Stops do not eliminate gap risk. These are risk-envelope
defaults, not evidence-based alpha parameters, and must not be raised automatically.

The broader goal is to borrow institutional *discipline*, not to imitate Renaissance
or Medallion. Kairos does not have their proprietary data, dense diversified signal
library, low-latency execution, capacity research, or decades of independent outcomes.
The relevant, achievable standard is reproducible point-in-time research, realistic
costs, strict market-local risk limits, out-of-sample promotion, and operational
monitoring. No return target or claim of Medallion-like capability is valid.

### Quant capability target

| Capability | Kairos direction | What not to pretend |
|---|---|---|
| Data provenance | Freeze evidence, policy, code, and quote fingerprints per decision | That a retail/free-data feed is an institutional consolidated low-latency feed |
| Research validation | Point-in-time replay, walk-forward, purging, costs, and regime slices | That a backtest proves a live edge |
| Portfolio construction | Market-local constraints, concentration/correlation controls, and explicit sleeves | That a small number of paper outcomes calibrates a universal optimizer |
| Execution | Fresh quote, spread, drift, idempotency, reconciliation, and broker protections | That cron polling can compete with a market maker or HFT firm |
| Learning | Separate populations and promotion defaults-to-no-change | That an LLM or a short sample can discover stable alpha |

These are the useful quantitative similarities to pursue. Additional indicators,
more agents, or frequent retraining are not substitutes for these controls and are
not part of this feature.

## 2. Existing State and Gaps

### Existing controls that must remain in force

- `lib/trading/symbol-policy.ts` blocks leveraged and inverse ETFs from generic
  research, paper, and live paths.
- `lib/asset-classification.ts` identifies a static set of known US ETFs, including
  several leveraged products. This is insufficient as an authority for a new money
  path because it does not model leverage factor, direction, issuer, or status.
- The generic US ETF allocation cap in `lib/trading/execute-order.ts` is a global ETF
  cap. It is not a leveraged-sleeve cap and cannot authorize a leveraged trade.
- Paper entry attempts currently occur at two deterministic in-session windows:
  US at 15:15 UTC and 19:15 UTC, and India at 09:40 IST and 13:15 IST. The US
  wakes are 11:15/15:15 EDT and 10:15/14:15 EST, respectively. They are not
  random or continuously polling entries, but static UTC cron cannot preserve an
  exact ET minute across daylight saving.
- The live auto worker and live exit monitor exist behind false-by-default deployment
  and database gates. They must remain disabled for this feature's paper phases.

### Gaps that block an enablement

1. Static ticker lists cannot safely classify all future leveraged, inverse, single-
   stock, or renamed funds.
2. The current technical score is a general equity score. It does not measure daily
   reset/path risk, underlying trend persistence, intraday liquidity, or execution
   spread for a leveraged product.
3. Paper PositionMonitor is not a reliable intraday protective system. A periodic
   quote check cannot protect an outage or overnight gap.
4. Existing paper results are not an isolated leveraged-ETF experiment and cannot
   justify sizing or live activation.

## 3. Instrument Classification and Allowlist

Create a server-owned `tradable_instruments` policy record rather than inferring from
a ticker. The initial record fields are:

```ts
type InstrumentPolicy = {
  symbol: string;
  market: "us" | "india";
  currency: "USD" | "INR";
  assetType: "equity" | "etf";
  leverageClass: "none" | "long_2x" | "long_3x" | "inverse" | "leveraged_inverse" | "unknown";
  underlyingSymbol: string | null;
  sleeve: "core" | "leveraged_us" | "blocked";
  enabledForPaper: boolean;
  enabledForLive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  reviewedAt: string;
};
```

Rules:

- Only explicit `long_2x` or `long_3x`, `sleeve='leveraged_us'`, and
  `enabledForPaper=true` may reach the isolated paper candidate flow.
- `inverse`, `leveraged_inverse`, `unknown`, single-stock leveraged products, crypto
  leveraged products, and every unlisted ticker remain blocked. The existing paper-
  only hedge exception remains separate and may not use this sleeve.
- The first allowlist must contain only broad, liquid, long index/sector products.
  It must not include single-stock or crypto leveraged ETFs. Each addition is an
  owner-reviewed policy change with an audit record, not a watchlist side effect.
- A policy lookup/read error is a money-path denial. It may not fall back to the
  old static ticker set.

## 4. Leveraged-ETF Decision Model

No LLM may decide eligibility, instrument class, size, stop, target, or exit. LLM
output can explain a completed deterministic decision only.

The leveraged model is a second deterministic gate after the normal new-long gates;
it can only reject or reduce an otherwise valid candidate.

### Required measurements

| Measurement | Purpose | Initial use |
|---|---|---|
| Underlying trend and persistence | Daily-reset leverage benefits more from persistent than choppy moves | Require a pre-declared, paper-validated underlying trend regime; no ad-hoc threshold |
| Realized volatility and ATR-normalized range | Detect path-risk / volatility drag conditions | Reject or reduce exposure above a market-local calibrated ceiling |
| Gap and overnight risk | Daily stops do not control discontinuous loss | Require a maximum expected loss and separate overnight policy |
| ETF quote age, bid/ask spread, dollar volume | Avoid paying large implementation shortfall | Fail closed on stale/unavailable quotes or excessive spread; thresholds calibrated from observed data |
| Underlying/ETF tracking sanity | Catch stale, dislocated, halted, or bad price data | Reject on abnormal divergence, stale underlying, or a trading halt |
| Portfolio beta/correlation | Prevent duplicate exposure (for example, QQQ plus TQQQ) | Enforce against the US book using the existing correlation framework; never cross-sum India |
| Event risk | Avoid automatic entry immediately before known binary events | Start with an exclusion policy for underlying index/sector events only where reliable data exists |

MACD, RSI, EMA, ATR, volume confirmation, and relative strength may be evaluated as
features in the isolated experiment. They are not sufficient by themselves, and none
should receive a permanent weight without point-in-time, costed, market-local evidence.
Fibonacci levels, Elliott wave, and similar discretionary chart patterns are not part
of this money path because they add degrees of freedom without a validated decision
contract.

### Sizing and exits

```text
leveraged_notional = min(
  normal_new_long_notional,
  3% of current US paper NAV,
  remaining 5% US leveraged sleeve capacity,
  liquidity/spread-constrained notional,
  volatility-scaled risk budget,
  all existing name/sector/gross/correlation/cash constraints
)
```

- Recalculate current NAV and all marks in USD at the same decision timestamp.
- Never use cost basis, stale cache values, or cash alone for sleeve capacity.
- A generic 7% stop / 20% target must not be copied blindly. The experiment records
  candidate volatility-normalized exits, but the active paper policy starts with a
  conservative deterministic stop/time-risk plan defined before entry and immutable
  on the trade record.
- No capital rotation into or out of this sleeve in the first phase. It would mix
  the new experiment with the established alpha book and amplify churn.
- The LearnerAgent cannot mutate the core champion or learn core signal weights from
  these outcomes. Leveraged outcomes have their own evaluation population.

## 5. Execution Sessions

Regular-session hours are 09:30-16:00 ET for US equities and 09:15-15:30 IST for
NSE equities. Kairos must remain regular-session-only. Extended-hours orders, random
polling, and "trade whenever a score changes" are out of scope.

The opening and closing periods have higher uncertainty, volatility, and often worse
spreads. A study of intraday trading activity finds U-shaped volume and price
variability, and liquidity research also documents wider spreads at the edges of the
day. Therefore, the product uses fixed decision windows, not a claim that any single
minute is universally optimal.

| Flow | US equities / ordinary ETFs | India equities | Leveraged-US ETF sleeve |
|---|---|---|---|
| Research | Existing morning and afternoon cycles | Existing morning and midday cycles | Reuse only a fresh same-session deterministic snapshot |
| New entry | Keep the existing two in-session wakes; normalize any future exact local-time policy in the route, not only in UTC cron | Keep existing 09:40 and 13:15 IST windows | One dedicated paper window, initially 11:00 ET, after the opening auction settles and before late-day rebalance pressure; never at the open or within 60 min of close |
| Routine exit review | Existing PositionMonitor policy | Existing PositionMonitor policy | Same end-of-session plan plus a separately qualified risk monitor |
| Emergency exit | Not a reason to add random entry polling | Not a reason to add random entry polling | Risk-reducing only: immediately actionable when reliable quote/broker state says the immutable stop/disaster rule fired |

The exact 11:00 ET leveraged entry time is a conservative starting experiment, not a
universal alpha claim. It must be compared with the existing fixed windows using
timestamped, costed paper evidence before it becomes a permanent policy. A cron may
wake the endpoint more broadly, but `America/New_York` time-window code must be the
single execution authority; DST can never silently move a policy window.

### Intraday exits: correct order of implementation

1. **Do not add an intraday exit cron using stale/free daily prices.** It could sell
   on a bad mark and create a false sense of protection.
2. Build a quote-quality contract: executable quote timestamp, bid, ask, spread,
   source health, halt/session status, and broker-held quantity.
3. In paper, record every would-exit at a fixed 15-minute cadence, but do not alter
   the established book until mark quality and false-trigger statistics are known.
4. For any future live entry, a broker-resident disaster floor/protective order plus
   reconciliation is required. The app monitor is a second line, not the primary
   protection against an outage or gap.
5. A risk-reducing verified SELL may run outside entry windows during the regular
   session. It remains subject to held-quantity/reconciliation guards, never a
   BUY budget, and never opens a short position.

## 6. Evidence and Promotion

The sleeve has a separate immutable experiment lineage. Each decision stores the
instrument-policy version, underlying and ETF quotes, features, rule version, entry
window, model outcome, transaction-cost assumptions, and market-local session date.

Required evidence before any expansion:

- point-in-time replay with correct fund availability and no survivorship additions;
- walk-forward evaluation and purged/time-separated validation;
- costs and conservative bid/ask/slippage sensitivity, not close-to-close returns;
- distinct regime slices (trending, high-volatility, mean-reverting) and a minimum
  number of independent setups, not daily observations counted as independent;
- comparison with the same underlying unlevered ETF and a cash/no-trade baseline;
- maximum drawdown, gap, false-exit, quote-quality, and reconciliation reporting;
- an owner-approved paper evidence threshold. Failure means no change, not a lower
  threshold.

No result from this experiment may promote a core strategy version, relax a generic
ETF cap, expand the live auto lease, or change India logic.

## 7. Phased Delivery

### L0 - policy and observability

- Add the classified instrument registry, owner-visible sleeve status, and a strict
  default-deny rule.
- Add a pure, tested market-local execution-window policy. It changes no existing
  schedule or order behavior in L0; later phases use it to enforce an approved ET
  window irrespective of UTC/DST.
- Keep all leveraged instruments blocked from generic research and execution.
- Add no cron, no provider, no live broker call, and no scoring influence.

### L1 - measure-only research

- Produce deterministic candidate feature records only for explicitly allowlisted
  instruments, paced separately from the core research quota.
- Capture quote quality, regime, normalized volatility, and would-enter/would-reject
  decisions. No paper fills.

### L2 - isolated paper sleeve

- Enable one US paper-only position under the 3%/5% envelope.
- Use the dedicated 11:00 ET entry window, immutable entry plan, and separate
  outcomes/analytics.
- Enable 15-minute *would-exit* observations only after quote contract tests pass.

### L3 - paper risk monitor

- If L2 shows reliable marks, activate deterministic risk-reducing paper exits at
  the approved cadence. Continue end-of-session monitoring as the fallback.
- Demonstrate no duplicate exits, no stale-mark exits, and correct market-local
  session behavior in failure injection.

### L4 - live design review only

- This is not authorization to trade live. It requires broker-native protective
  support, reconciliation, a live-specific allowlist, live account mandate, small
  owner-approved lease, and a separately approved architecture.

## 8. Acceptance Criteria

- An unclassified, inverse, leveraged-inverse, single-stock, crypto, India, or
  expired allowlist instrument is denied before any score, claim, fill, or order.
- The sleeve cannot exceed 3% for one name or 5% in aggregate using current US NAV.
- India INR holdings and capacity never participate in US sleeve calculations.
- A missing policy, quote, mark, NAV, spread, or correlation read rejects a new
  leveraged entry; it never falls back to the generic ETF path.
- Leveraged results are excluded from core LearnerAgent promotion/weight mutation.
- A repeated worker, stale quote, quote divergence, halt, partial exit, broker
  uncertainty, or kill switch cannot create a duplicate order or oversell.
- New entries occur only in their approved regular-session window. Verified
  risk-reducing exits may occur during regular session outside that window.
- No production flag, mandate, account, generic ETF cap, or live order capability
  changes in L0-L3.

## 9. Sources

- FINRA, [The Lowdown on Leveraged and Inverse Exchange-Traded Products](https://www.finra.org/investors/insights/lowdown-leveraged-and-inverse-exchange-traded-products): daily reset and the greater divergence caused by leverage and volatility.
- FINRA, [Non-Traditional ETFs FAQ](https://www.finra.org/rules-guidance/key-topics/etf/non-traditional-etf-faq): suitability must consider volatility, leverage, and holding period.
- Wei (1992), [Intraday Variations in Trading Activity, Price Variability, and the Bid-Ask Spread](https://doi.org/10.1111/j.1475-6803.1992.tb00804.x): empirical U-shaped intraday activity and variability.
- NYSE, [Trading Information](https://www.nyse.com/trade/trading-information?os=io_): US core session hours.
- NSE, [Market Timings and Holidays](https://www.nseindia.com/resources/exchange-communication-holidays): NSE regular equity session hours.

## 10. Explicit Non-Goals

- No claim of Renaissance/Medallion equivalence.
- No HFT, market making, order-book prediction, extended-hours trading, options,
  inverse ETF trading, or cross-market/currency netting.
- No new LLM authority, external GitHub skill runtime, or provider-quota increase.
- No live leveraged trade, even manually, under this architecture without the L4
  approval and a distinct live safety review.

## 11. Implementation record — 2026-09-13

L0–L1 is implemented locally in commit pending verification: the only accepted
measurement symbols are long 3x `TQQQ` (underlying `QQQ`) and `SOXL`
(`SOXX`). `SQQQ` and `SOXS` remain inverse-blocked. The collector records a
single 11:00–11:14 ET observation with quote/underlying freshness, spread and
raw volatility/trend/liquidity fields, but its only possible decision is
`observe_only`. It cannot create a score, candidate, paper fill, broker call,
or live order.

The schema is deliberately unapplied while the FinanceOS production migration
lineage is unreconciled. There is also no scheduled collector yet: the current
quote contract has no verified executable bid/ask provider. A daily job must
not be enabled until it can supply those inputs rather than substituting a
daily OHLC cache. L2–L4 remain unimplemented and unapproved.
