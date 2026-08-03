# US Keyless Screener — Feature Architecture

Status: **Draft — awaiting owner approval. No code written.**
Author: Claude · 2026-08-02
Revision 2 — supersedes the Nasdaq-Trader-universe design in revision 1 (§13).
Related: `features/feature-pack-validation/`, `docs/arch/03-agents.md`.

---

## 1. Why this exists

US candidate discovery is dead and has been for at least ten days.

`decision_observations`, 2026-07-23 → 2026-08-02, by `discovery_source`:

| Market | Source | n |
|---|---|---:|
| US | `holding` | 600 |
| US | `watchlist` | 151 |
| US | `manual` | 48 |
| US | `screener_momentum` / `screener_value` | **0** |
| India | `india_holding` | 140 |
| India | `india_screener` | 87 |
| India | `manual` | 13 |

Cause: the FinancialDatasets key is at `$0.00` (observed 2026-07-29).
`runScreener()` returns `[]` and the run continues from other queues — fail-soft,
no crash, nothing visibly broken.

The consequence is not "fewer candidates." **Every US decision for ten days
concerned a name the system already held or already watched.** The evidence record
being accumulated right now — the same record gating threshold recalibration,
learner promotion, and every feature-pack decision — is a closed loop over prior
selections. That bias does not appear in any row count.

India is unaffected; it never used FinancialDatasets.

### Why not simply top up the key

1. **Recurrence.** The failure mode is a paid provider going quiet while the system
   reports healthy. Topping up restores discovery until the next exhaustion. The
   alarm gap (§7) is the real defect; the balance is only the trigger.
2. **Standing constraint.** The owner's standing rule is $0 cloud. A paid
   dependency on the discovery path is a permanent exception to it.

Topping up remains a legitimate choice; §6 keeps the FinancialDatasets path as a
fallback.

---

## 2. What is proposed

Replace the FinancialDatasets screener call with Yahoo's **custom screener
endpoint** — keyless, server-side, and already reachable using the crumb/cookie
handshake this codebase implements for India.

```
POST https://query2.finance.yahoo.com/v1/finance/screener?crumb=<crumb>
```

Two calls per research run: one momentum bucket, one value bucket. Yahoo evaluates
the criteria across the whole US listed universe and returns ranked, capped
results.

**Scope boundary: discovery only.** It changes which symbols enter the research
batch. It does not touch scoring, direction, eligibility, sizing, entries, exits,
promotion, or any broker path.

---

## 3. Verification — all of this was probed live, 2026-08-02

Not reasoned from documentation. Actual responses.

**Endpoint reachable, keyless.** `GET /v1/test/getcrumb` with a `fc.yahoo.com`
cookie yields a crumb; the POST returns `200`.

**All eight fields the current buckets need exist as screener criteria.** Each
probed individually with a `gt 0` filter:

| FD field | Yahoo criterion | Matching US names |
|---|---|---:|
| `revenue_growth` | `quarterlyrevenuegrowth.quarterly` | 9,029 |
| `earnings_growth` | `epsgrowth.lasttwelvemonths` | 7,563 |
| `gross_margin` | `grossprofitmargin.lasttwelvemonths` | 13,198 |
| `return_on_equity` | `returnonequity.lasttwelvemonths` | 10,760 |
| `price_to_earnings_ratio` | `peratio.lasttwelvemonths` | 8,899 |
| `debt_to_equity` | `totaldebtequity.lasttwelvemonths` | 12,210 |
| `market_cap` | `intradaymarketcap` | — |
| `free_cash_flow_yield` | `freecashflow.lasttwelvemonths` (absolute, **not** yield) | 19,873 |

**Units are percentages, not ratios.** `returnonequity.lasttwelvemonths > 15`
means 15%, not 1500%. `totaldebtequity` likewise: `< 100` is the ratio `< 1.0`.
Every threshold must be multiplied by 100 when ported. A ratio passed unconverted
would match everything and silently disable the filter.

**The full momentum bucket returns real results.** revG>15, epsG>10, GM>25,
ROE>15, mcap>2e9 → `total: 366`.

### The contamination finding — and why an exchange filter is mandatory

With `region = us`, that momentum bucket's top results were:

```
GGPSF, NVPTF, IDDTF, IDTVF, NLY, NLY-PF, NLY-PG, KXIAY
```

Mostly OTC/pink-sheet foreign issues (the `F`/`Y` suffixes) and **preferred share
series** (`NLY-PF`, `NLY-PG`). The value bucket was worse: `CBAOF`, `LYTHF`,
`BBAGF`. These are not tradeable US common stock; Robinhood cannot fill most of
them, and a preferred series is not the security the score describes.

Constraining to `exchange in (NMS, NYQ)` plus `dayvolume > 500000`:

```
NLY, MU, SKHY, IBRX, BE, CRDO, SIMO, IAG, ERO, CORZ    (total: 132)
```

Liquid NASDAQ GS / NYSE common stock. **The exchange and volume filters are not
optional hardening — without them this feature injects untradeable symbols into
research.**

---

## 4. Design

### 4.1 `lib/data/yahoo-screener.ts` (new)

```ts
POST https://query2.finance.yahoo.com/v1/finance/screener?crumb=<crumb>
body: { size, offset, sortField, sortType, quoteType: "EQUITY", query: {…} }
```

Reuses the existing `getCrumb()` cookie/crumb helper — no new auth surface.

Every query carries a mandatory base clause, applied by the module and not
overridable by callers:

- `exchange` in `NMS` | `NYQ`
- `dayvolume > 500_000`
- `quoteType = "EQUITY"`

Response symbols are additionally validated against the existing symbol policy
before entering research: reject anything containing `-` or `.` (preferred series,
units, warrants), reject known leveraged/inverse products via
`isLeveragedInverseEtf`.

### 4.2 Bucket definitions

Thresholds carried over from the current FD filters, converted to percent:

**momentum** — sort `quarterlyrevenuegrowth.quarterly` DESC
```
quarterlyrevenuegrowth.quarterly  > 15
epsgrowth.lasttwelvemonths        > 10
grossprofitmargin.lasttwelvemonths> 25
returnonequity.lasttwelvemonths   > 15
intradaymarketcap                 > 2_000_000_000
```

**value** — sort `peratio.lasttwelvemonths` ASC
```
peratio.lasttwelvemonths          > 0
peratio.lasttwelvemonths          < 18
totaldebtequity.lasttwelvemonths  < 100        (= ratio 1.0)
freecashflow.lasttwelvemonths     > 0          (see §5)
intradaymarketcap                 > 1_000_000_000
```

The existing round-robin interleave and cap are unchanged. The locked rule of
**3 screener candidates/day** is unchanged — this restores supply to a starved
funnel, it does not widen the gate.

### 4.3 `runScreener()`

```
1. Yahoo custom screener, both buckets
2. on failure, and only if a funded FD key exists → existing FinancialDatasets path
3. else → [] and raise the staleness issue (§7)
```

---

## 5. The one deviation requiring explicit sign-off

**Free-cash-flow yield cannot be expressed.** Yahoo offers
`freecashflow.lasttwelvemonths` — an absolute dollar figure — not a yield. The
returned quote payload does not carry `freeCashflow`, so the yield cannot be
derived post-hoc without an extra call per symbol.

The current value bucket requires `free_cash_flow_yield > 0.04`. The proposal
substitutes `freecashflow.lasttwelvemonths > 0` — positive free cash flow, not a
4% yield.

**This is a genuine loosening of the value bucket**, not a source swap. It admits
cash-generative but expensively-valued names the FD filter excluded. Everything
else in this document is threshold-preserving; this one is not, and it should not
be waved through as an implementation detail.

Three ways to handle it, owner's call:

- **(a)** Accept the loosening. Simplest. Value bucket is one screen among two,
  downstream scoring and the 3/day cap still bind.
- **(b)** Compensate by tightening P/E (e.g. `< 15`) to hold selectivity roughly
  constant. Arbitrary, but preserves the admission rate.
- **(c)** Drop the FCF leg entirely and say so, rather than substituting a weaker
  proxy that reads like the original.

I recommend **(a)** with the deviation recorded in `PROJECT_DECISIONS.md`.
Pretending `FCF > 0` is equivalent to `FCF yield > 4%` is the outcome to avoid;
naming it is sufficient.

---

## 6. What is deliberately not changed

- No score, weight, threshold, direction, eligibility, sizing, entry, exit,
  promotion, or broker behaviour.
- No change to the candidates/day cap.
- FinancialDatasets is **kept** as fallback, not deleted.
- Long-only for new entries; SELL capability on holdings untouched.
- India path untouched.

---

## 7. The alarm — the actual defect being fixed

The ten-day outage was silent. `runScreener()` did call `reportIssue()` on a
missing key, but nothing watched what matters: **whether US discovery produced any
candidate at all.**

Add a market-local discovery-coverage check:

- raise `discovery-starved:us` at `warn` when a research run completes with zero
  screener-sourced candidates
- escalate to `critical` after three consecutive such runs
- resolve on the first run that yields one

**Ship this first, independently.** It is small, depends on nothing else here, and
without it the next discovery outage — from any cause, keyless or paid — is
equally invisible.

---

## 8. Honesty constraints

Yahoo's screener evaluates **current** listings and current fundamentals. It is
not point-in-time and carries survivorship bias by construction.

Acceptable for *discovery* — choosing what to research now is a present-tense
question. **Not** acceptable as backtest or IC input. These results must not feed
`lib/edges/` OOS folds, the PIT universe resolver, or any evidence pool without a
separate PIT contract and separate approval.

The Upgrade Path must describe this as restored discovery breadth, never as an
alpha improvement. Widening the funnel changes what gets examined, not what is true.

---

## 9. Risks

**R1 — undocumented endpoint (accepted, mitigated).** `/v1/finance/screener` is
not a published API. Yahoo can change the field vocabulary, the crumb flow, or
the response shape without notice. Mitigations: the §7 alarm makes failure loud;
the FD fallback survives; the field mapping is a single table in one module.
This is the principal risk and it is real.

**R2 — single-provider concentration.** After this, both markets' discovery
depends on Yahoo. Today India alone dies if Yahoo blocks; after this, both do.
Partially mitigated by keeping the FD fallback funded-or-not.

**R3 — unit errors.** Percent-vs-ratio (§3) is the specific trap;
`totaldebtequity < 1.0` instead of `< 100` would silently pass every name.
Mitigation: unit assertions in tests, one per threshold.

**R4 — untradeable symbols entering research.** Proven real (§3). Mitigation: the
mandatory base clause and symbol-policy validation in §4.1, with a test asserting
that a known OTC and a known preferred series are both rejected.

**R5 — rate limiting.** Two POSTs per research run is negligible next to India's
600-symbol nightly rotation. Low.

---

## 10. Acceptance gates

1. Both buckets return non-empty from the deployed environment (not just locally
   — Vercel egress differs).
2. Every returned symbol passes exchange, volume, and symbol-policy validation;
   tests assert an OTC ticker and a `-P` preferred series are rejected.
3. Unit tests assert percent-scaled thresholds for all six numeric criteria.
4. `discovery_source` shows non-zero `screener_momentum` / `screener_value` for US
   on the first post-deploy research run.
5. The §7 alarm fires in a forced-empty test and resolves on recovery.
6. The §5 deviation is recorded in `PROJECT_DECISIONS.md` with the owner's choice.
7. `npx tsc --noEmit`, `npx vitest run`, `npm run build` all clean.

---

## 11. Documentation to update on ship

- `docs/arch/02-tech-stack.md` — Yahoo screener as a US discovery provider
- `docs/arch/03-agents.md` — ResearchAgent discovery inputs
- `public/agent-diagrams/system-map.json` — node + `history` entry
- `PROJECT_DECISIONS.md` — keyless-over-paid discovery, and the §5 deviation

No migration, no new table, no new cron.

---

## 12. Open questions for the owner

1. **Approve the direction?** Yahoo keyless screener, or top up FinancialDatasets?
2. **§5 — which handling of the lost FCF-yield filter?** (a) accept, (b) tighten
   P/E to compensate, or (c) drop the leg explicitly. Recommend (a).
3. **Ship §7's alarm first, separately?** Recommend yes, regardless of 1 and 2.

---

## 13. Revision history

**Rev 2 (2026-08-02).** Rewritten after probing Yahoo's custom screener endpoint
live. Rev 1 proposed enumerating a US universe from the Nasdaq Trader symbol
directory into a new `us_screen_cache` table, refreshed by a nightly cron
rotating 600 symbols per run — mirroring India's architecture, which exists
because Yahoo has no *India* screener coverage worth using.

For US, Yahoo screens server-side. That deletes the universe file, the table, the
migration, the cron, and the multi-night rotation, replacing all of it with two
POST requests. Rev 1's Nasdaq Trader reachability gate is moot; both files were
confirmed reachable (`200`, 345KB and 533KB) but are no longer needed.

Rev 1 also missed the OTC/preferred contamination entirely, because a
directory-file universe would have filtered those out structurally. Screening
server-side surfaces them, which is why §4.1's base clause exists.
