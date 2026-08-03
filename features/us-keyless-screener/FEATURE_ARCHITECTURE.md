# US Keyless Screener — Feature Architecture

Status: **Draft — awaiting owner approval. No code written.**
Author: Claude · 2026-08-02
Revision 3 — corrects rev 2's field validation and drops the FCF leg (§13).
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

**Seven of the eight fields are honoured. One is silently ignored.**

An earlier revision of this section listed all eight as validated, each probed
with a `gt 0` filter and a result count. **That method was wrong and the
conclusion it produced was wrong.** A `gt 0` filter is nearly a no-op whether the
criterion is honoured or discarded, so a non-zero count proves only that the
request did not error. It cannot distinguish a working filter from an ignored
one. The corrected method is an **absurd-value control**: set a threshold no
security can satisfy and confirm the count collapses.

Baseline — exchange + volume + `intradaymarketcap > 1e9`, no other criterion:
**1,831** names.

| FD field | Yahoo criterion | sane | absurd | verdict |
|---|---|---:|---:|---|
| `revenue_growth` | `quarterlyrevenuegrowth.quarterly` | 639 | 0 | honoured |
| `earnings_growth` | `epsgrowth.lasttwelvemonths` | 822 | 0 | honoured |
| `gross_margin` | `grossprofitmargin.lasttwelvemonths` | 1,338 | 0 | honoured |
| `return_on_equity` | `returnonequity.lasttwelvemonths` | 642 | 0 | honoured |
| `price_to_earnings_ratio` | `peratio.lasttwelvemonths` | 890 | 385 | honoured |
| `debt_to_equity` | `totaldebtequity.lasttwelvemonths` | 1,093 | 91 | honoured |
| `free_cash_flow_yield` | `freecashflow.lasttwelvemonths` | 1,831 | **1,831** | **IGNORED** |
| *(unused)* | `netincomemargin.lasttwelvemonths` | 1,110 | 0 | honoured |

`freecashflow.lasttwelvemonths > 999,999,999,999,999` — one quadrillion dollars —
returns the same 1,831 as no filter at all. The criterion is accepted by the API
and discarded. Market-cap banding does not recover it either: four bands with
band-relative FCF floors summed to exactly the unbanded total.

The `fields` request parameter is also ignored — the response is a fixed 89-key
quote payload with no `freeCashflow`, so the yield cannot be computed client-side
from screener output either.

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
intradaymarketcap                 > 1_000_000_000
```

No free-cash-flow leg — see §5. It is omitted rather than approximated.

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

## 5. The free-cash-flow leg is dropped

The current value bucket requires `free_cash_flow_yield > 0.04`. **No Yahoo
criterion can express it, and there is no weaker working substitute.**

Yahoo offers `freecashflow.lasttwelvemonths` — absolute dollars, not a yield —
and §3 proves that criterion is silently discarded. So the previously-considered
options collapse:

- *Accept `freecashflow > 0` as a loosening* — not available. The filter does
  nothing at any threshold.
- *Band the market cap and use a band-relative FCF floor* — not available. The
  bands summed to the unfiltered total.
- *Compute the yield from screener output* — not available. `freeCashflow` is
  absent from the response and the `fields` parameter is ignored.

The leg is therefore **omitted**, and the value bucket becomes `0 < P/E < 18`,
`debt/equity < 1.0`, `market cap > $1B`, plus the mandatory exchange/volume base
clause.

**What is genuinely lost:** the independent cash-flow cross-check on accounting
earnings. P/E still carries "cheap" and debt/equity still carries balance-sheet
quality, so the bucket remains coherent — but it no longer verifies that reported
earnings convert to cash.

**Why no proxy is substituted.** `netincomemargin.lasttwelvemonths` is honoured
and would look like a reasonable stand-in. It is not: it is earnings-derived, and
cross-checking earnings against earnings is circular — precisely the check the FCF
leg existed to provide. A proxy that reads like the original while providing none
of its independence is worse than an acknowledged gap.

Record in `PROJECT_DECISIONS.md` as a deliberate omission with this reasoning, so
a later reader does not restore it by adding a field that does not work.

---

## 5b. Field-contract control — permanent, not a one-off

The §3 discovery is the strongest argument in this document, and it is not about
free cash flow. **A screener criterion can be accepted by the API, returned
without error, and contribute nothing.** No exception, no warning, no test
failure — just a filter that quietly stops filtering.

R1 (undocumented endpoint) is not a hypothetical risk to be accepted with a
shrug. It materialised on the first field probed carefully, before any code was
written. Every remaining honoured field is one Yahoo deployment away from the
same state, and the failure is invisible by construction: the screen keeps
returning names, the run keeps succeeding, and the bucket silently widens to
whatever the surviving criteria allow.

**Ship an absurd-value control as a live contract check**, not a one-time
validation:

- for each criterion, issue the bucket query with a threshold no security can
  satisfy (`gt` → absurdly high, `lt` → absurdly low)
- the count must collapse relative to the same query without that criterion
- if it does not, the criterion is a no-op: raise
  `screener-field-degraded:<field>` at `critical` and **fall back to
  FinancialDatasets** rather than screening on a bucket that is quietly wider
  than its definition

Run it on a schedule, not per research run — the probe costs one request per
field and the condition changes on Yahoo's deploy cadence, not hourly. Daily,
alongside the existing model-freshness check, is sufficient.

This is cheap, it protects all seven working legs rather than the one that
failed, and without it the next silent deprecation produces a wider screen that
nothing reports. It is the piece of this proposal most worth keeping even if the
screener direction is rejected in favour of funding FinancialDatasets — the same
class of check applies to any provider whose contract is not versioned.

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

**R1 — undocumented endpoint (materialised, mitigated).** `/v1/finance/screener`
is not a published API. Yahoo can change the field vocabulary, the crumb flow, or
the response shape without notice. **This is no longer hypothetical:
`freecashflow.lasttwelvemonths` is already in the failed state (§3), accepted and
discarded, and was caught only because it was probed with an absurd-value
control.** Mitigations: the §5b contract check turns a silent no-op into a
`critical` issue with an automatic FD fallback; the §7 alarm catches total
discovery failure; the field mapping is a single table in one module. This is the
principal risk and §5b is the reason it is survivable.

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
3b. The §5b absurd-value control passes for every criterion in both buckets at
   ship time, and its scheduled job is registered. A criterion that fails the
   control must not be in a shipped bucket.
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
2. ~~Which handling of the lost FCF-yield filter?~~ **Resolved by measurement,
   not by preference.** No working substitute exists; the leg is dropped (§5).
   Confirm you accept the value bucket without a cash-flow cross-check.
3. **Ship §5b's field-contract control regardless of 1?** Recommend yes. It
   applies to any unversioned provider contract, including a re-funded
   FinancialDatasets.
4. ~~Ship §7's alarm first?~~ **Done** — `discovery-starved:us` shipped in
   `66b7862e`, independent of everything else here.

---

## 13. Revision history

**Rev 3 (2026-08-02).** Corrects rev 2's field validation, which was unsound.
Rev 2 probed each criterion with a `gt 0` filter and treated a non-zero result
count as proof the field worked. That test cannot fail: a `gt 0` filter is nearly
a no-op whether the criterion is honoured or discarded, so it demonstrated only
that the request did not error. Re-probed with an absurd-value control,
`freecashflow.lasttwelvemonths` proved to be silently ignored — accepted by the
API and contributing nothing at any threshold, including one quadrillion dollars.
Rev 2's §5 offered three ways to handle a "loosened" FCF filter; all three assumed
a filter that does not exist. The leg is dropped (§5), and the control test is
promoted to permanent infrastructure (§5b) because the same failure can silently
disable any of the seven working criteria.

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
