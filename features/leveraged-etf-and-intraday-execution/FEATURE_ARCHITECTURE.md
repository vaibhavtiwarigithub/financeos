# Leveraged ETF Sleeve and Intraday Execution Architecture

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
