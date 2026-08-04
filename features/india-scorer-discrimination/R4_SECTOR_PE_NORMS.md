# R4 — Is the US sector P/E table biasing India's fundamental score?

**Status: evidence only. Nothing here is approved. No code, table, weight, threshold
or config was changed. All queries were read-only against project
`dionkikgdmlaotvtbnfr`.**

Scope: `DIAGNOSIS.md` §7 / §11-R4 / §14. Question: does `SECTOR_PE_NORM` — a US
sector-median P/E table — systematically mis-score NSE names, and does that
deserve promotion above its current LOW priority?

Evidence date: 2026-08-03.

---

## 1. The table and its consumers

`lib/data/scores.ts:64-72`:

```
technology 30 · communication services 20 · health care 25 · healthcare 25
consumer discretionary 24 · consumer cyclical 24 · consumer staples 22
consumer defensive 22 · industrials 20 · materials 16 · basic materials 16
energy 12 · financials 14 · financial services 14 · utilities 18 · real estate 30
```

**Provenance recorded in-source** (`lib/data/scores.ts:59-63`): "Rough sector
median P/E … Deliberately coarse priors; the IC-gated path can refine per market
once there's enough data." So the table is self-declared as a US-shaped prior with
a per-market refinement explicitly deferred. There is no citation, no as-of date,
and no market key.

**Consumers:**

| Site | Role |
|---|---|
| `lib/data/scores.ts:97-109` `resolveSectorPeBenchmark()` | Only reader of the table. Direct key lookup, or `FINNHUB_INDUSTRY_TO_SECTOR` crosswalk when `taxonomy === "finnhub_industry"`. Unmapped → `norm: null`. |
| `lib/data/scores.ts:137-149` `scoreFundamentals()` | `ratio = pe / norm` → bands `<0.7 +18` · `<1.0 +8` · `<1.4 −3` · `<2.0 −12` · `≥2.0 −22`. |
| `lib/data/scores.ts:525` `computeScores()` | Sole production call path. |
| `lib/evidence/evaluation/cohort-builder.ts:309` | Replay/cohort recompute — same function, same table. |
| `tests/scoring-data-truth.test.ts`, `lib/data/score-input-governance.test.ts` | Tests. |
| `docs/arch/03-agents.md:352,359` | Documents the table verbatim. |

**There is no India-local branch anywhere.** `computeScores()` takes a `market`
argument (`lib/data/scores.ts:514-520`) and uses it for the macro dimension only.
`scoreFundamentals()` is never passed `market` and cannot see it. India and US names
hit the same 16-key US table. Confirmed by grep across the repo — `SECTOR_PE_NORM`
appears in exactly one source file.

---

## 2. Production distribution of India `pe_vs_sector_ratio`

`decision_observations`, market = india, 2026-07-07 → 2026-08-03.

| | rows | symbols |
|---|--:|--:|
| India total | 446 | — |
| carrying `pe_vs_sector_ratio` | **405** | 45 |
| no P/E component | 41 | 21 |

**The diagnosis' "only 23 India rows" is stale — the real base is 405 rows / 45
symbols.** The 23 figure counted only rows carrying the *post-fix evidence keys*
(`pe_scoring_status`, `pe_sector_mapping_status`); that cohort is now 41 rows / 21
symbols (2026-08-01 → 08-03). The other 364 rows (2026-07-13 → 07-31) carry
`pe_vs_sector_ratio` and `pe_sector_norm` but not the status keys — they were
scored by the same P/E band logic and are legitimate evidence for R4. Sector for
those rows was recovered via `features.fundamental.sector`.

By sector (all 405; band columns = count of rows landing in each scoring band):

| sector | US norm | rows | syms | median ratio | +18 | +8 | −3 | −12 | −22 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| financial services | 14 | 124 | 13 | 0.83 | 50 | 23 | 28 | 0 | 23 |
| energy | 12 | 59 | 5 | 0.63 | 47 | 5 | 0 | 6 | 1 |
| technology | 30 | 56 | 5 | 0.57 | 42 | 14 | 0 | 0 | 0 |
| consumer cyclical | 24 | 50 | 5 | 1.15 | 0 | 14 | 12 | 3 | 21 |
| healthcare | 25 | 49 | 4 | 2.64 | 0 | 0 | 0 | 10 | 39 |
| utilities | 18 | 20 | 2 | 0.63 | 16 | 4 | 0 | 0 | 0 |
| industrials | 20 | 14 | 6 | 1.63 | 4 | 0 | 0 | 8 | 2 |
| communication services | 20 | 14 | 1 | 2.74 | 0 | 0 | 0 | 0 | 14 |
| real estate | 30 | 11 | 1 | 1.01 | 0 | 4 | 7 | 0 | 0 |
| consumer defensive | 22 | 8 | 2 | 0.80 | 0 | 6 | 0 | 0 | 2 |

**159/405 (39.3%) land in the +18 "cheap vs sector" band; 65/405 (16.0%) in +8.
55.3% of India rows collect a valuation bonus.** 89/405 (22.0%) take the −22
penalty. Overall median ratio 0.81.

Concentration matters: energy (47 of 59 rows at +18, 5 symbols) and technology
(42 of 56 rows at +18, 5 symbols) supply 89 of the 159 top-band bonuses — and
those are precisely the two sectors where the US norm is furthest *above* India
reality (§3).

---

## 3. US norm vs observed NSE reality — the core bias table

Observed India sector median trailing P/E from `india_screen_cache` (populated by
the nightly NSE rotation; 98 symbols, 96 with P/E, 97 with sector), filtered to
`0 < pe ≤ 200` to match `isScorablePe`.

`bias` = observed India median ÷ US norm. **bias > 1 ⇒ the US norm is too LOW ⇒
Indian ratios are inflated ⇒ India names are systematically penalised.
bias < 1 ⇒ the US norm is too HIGH ⇒ India names get an unearned discount.**

| sector | n (NSE) | India median P/E | US norm applied | bias | direction of error |
|---|--:|--:|--:|--:|---|
| communication services | 2 | 49.7 | 20 | **2.48×** | penalised hard |
| industrials | 10 | 48.6 | 20 | **2.43×** | penalised hard |
| consumer defensive | 11 | 52.6 | 22 | **2.39×** | penalised hard |
| basic materials | 13 | 41.4 | 16 | **2.59×** | penalised hard |
| consumer cyclical | 11 | 38.3 | 24 | 1.60× | penalised |
| healthcare | 8 | 37.4 | 25 | 1.50× | penalised |
| financial services | 21 | 19.5 | 14 | 1.39× | penalised |
| utilities | 6 | 21.6 | 18 | 1.20× | mild |
| real estate | 2 | 33.9 | 30 | 1.13× | mild |
| **energy** | 6 | 8.2 | 12 | **0.69×** | **unearned bonus** |
| **technology** | 6 | 19.1 | 30 | **0.64×** | **unearned bonus** |

**The bias spans 0.64× to 2.59× — a 4.0× spread. It is not a level shift that
cancels out; it is a per-sector rotation of the value ranking.** Nine of eleven
sectors are penalised, two are rewarded — and the two rewarded ones are where 56%
of all India +18 bonuses are being paid.

Concretely: INFY at P/E 14.0 scores +18 ("cheap") against the US technology norm
of 30. Against the observed NSE technology median of 19.1 it is +8 — cheap, but
not deeply so. Conversely LT at P/E 32.9 scores −12 ("expensive") against the US
industrials norm of 20, when the observed NSE industrials median is 48.6 — it is
in fact one of the cheaper industrials on the exchange and should score +18. The
table is not adding noise; it is reversing the sign on real cross-sectional value.

**Limit on this evidence (stated plainly):** `india_screen_cache` holds a *single*
snapshot (`scored_at` min = max = 2026-08-03) — the nightly rotation overwrites it,
so there is no history. Per-sector n ranges 2–21. `communication services`,
`real estate` (n=2) and `energy`, `technology`, `utilities` (n=6) are thin. The
direction and rough magnitude are solid for the well-populated sectors; the exact
medians are not stable enough to hard-code.

---

## 4. Frozen counterfactual — the admission flip table

Method (read-only, no historical row rewritten):

1. Reconstruct the non-P/E fundamental components from stored evidence
   (`profit_margin`, `roe`, `eps`, `revenue_growth_yoy`) exactly as
   `scoreFundamentals` scores them → `raw = 50 + other`.
2. Old P/E points = band(`pe / SECTOR_PE_NORM[sector]`); new P/E points =
   band(`pe / india_median[sector]`).
3. Clamp-aware delta: `Δ = clamp(raw + new) − clamp(raw + old)` — this correctly
   returns 0 when a fundamental already sits at the 100 ceiling.
4. Apply Δ to the **stored** `fundamental_score` (not the reconstruction), then
   `analyst_new = round(analyst_old − w_fund·fund_old + w_fund·fund_new)` using the
   row's own `weights_used`. Verified against stored values (AXISBANK
   0.545·99 + 0.455·0 = 54 = stored 54; ITC 0.545·73 + 0.455·8 = 43 = stored 43).
   Anchoring on the stored score avoids contaminating the flip table with the 34
   rows (8.4%) whose stored `fundamental_score` predates a mid-July scorer version
   and reconstructs 6–12 points low.
5. Threshold: each row's own `score_threshold` (India `trading_mandates` = **60**
   on all 405 rows).

| metric | value |
|---|--:|
| India rows evaluated | 405 |
| rows whose P/E component changes | **239 (59.0%)** |
| mean change to `fundamental_score` | +1.80 |
| rows passing ≥60 today | 302 (74.6%) |
| rows passing ≥60 under India-local norms | 306 (75.6%) |
| **flip IN** (fail → pass) | **11 rows / 6 symbols** |
| **flip OUT** (pass → fail) | **7 rows / 3 symbols** |
| net admission change | **+4 rows (+1.0pp)** |
| rows within ±2 of the 60 gate | 26 (6.4%) |

Named flips:

| dir | symbol | sector | rows | dates | P/E | US norm | India med | old pts | new pts | score → |
|---|---|---|--:|---|--:|--:|--:|--:|--:|---|
| IN | LT.NS | industrials | 3 | 07-13 → 08-03 | 32.9 | 20 | 48.6 | −12 | +18 | 50.3 → 65.3 |
| IN | ELECTCAST.NS | industrials | 1 | 07-13 | 29.7 | 20 | 48.6 | −12 | +18 | 48 → 61 |
| IN | BAJAJ-AUTO.NS | consumer cyclical | 1 | 07-25 | 26.4 | 24 | 38.3 | −3 | +18 | 51 → 62 |
| IN | SBIN.NS | financial services | 2 | 07-24 → 07-29 | 11.3 | 14 | 19.5 | +8 | +18 | 59 → 64 |
| IN | POWERGRID.NS | utilities | 2 | 07-29 → 07-31 | 14.1 | 18 | 21.6 | +8 | +18 | 55.5 → 60.5 |
| IN | LODHA.NS | real estate | 2 | 07-31 | 31.7 | 30 | 33.9 | −3 | +8 | 57 → 63 |
| OUT | INFY.NS | technology | 5 | 07-21 → 07-24 | 14.0 | 30 | 19.1 | +18 | +8 | 62 → 57 |
| OUT | ONGC.NS | energy | 1 | 07-20 | 7.6 | 12 | 8.2 | +18 | +8 | 64 → 59 |
| OUT | COALINDIA.NS | energy | 1 | 07-16 | 8.5 | 12 | 8.2 | +8 | −3 | 61 → 56 |

Per-sector flip attribution:

| sector | rows | mean P/E points change | flip in | flip out |
|---|--:|--:|--:|--:|
| industrials | 14 | +17.9 | 4 | 0 |
| communication services | 14 | +19.0 | 0 | 0 |
| consumer defensive | 8 | +12.3 | 0 | 0 |
| consumer cyclical | 50 | +8.4 | 1 | 0 |
| healthcare | 49 | +5.3 | 0 | 0 |
| financial services | 124 | +5.2 | 2 | 0 |
| real estate | 11 | +6.0 | 2 | 0 |
| utilities | 20 | +2.0 | 2 | 2 |
| energy | 59 | −6.5 | 0 | 2 |
| technology | 56 | −14.1 | 0 | 5 |

**Read this carefully: the component moves on 59% of rows and by up to ±30 points,
but the net gate effect is +4 rows.** The reason is that India's `fundamental_score`
is heavily top-coded (§7 of the diagnosis: 20.4% at 100) and the gate is far from
the mass of the distribution for most names — a ±10 to ±30 point swing in the P/E
component is absorbed by the clamp or lands well clear of 60. Only the 26 rows
(6.4%) sitting within ±2 of the gate are genuinely exposed, and 18 of the 405 rows
(4.4%) actually cross.

---

## 5. Sector taxonomy coverage

Verified over the full India history, not the 23-row sample:

| cohort | rows | syms | dates | mapping status | taxonomy |
|---|--:|--:|---|---|---|
| post-fix (status keys present) | 41 | 21 | 08-01 → 08-03 | `direct` 41/41 (**100%**) | `yahoo_sector` 41/41 |
| legacy (ratio, no status keys) | 364 | 44 | 07-13 → 07-31 | n/a (keys not written) | n/a |
| no P/E component | 41 | 21 | 07-07 → 07-23 | n/a | n/a |

Independent check against the NSE screener universe: `india_screen_cache` returns
11 distinct sector strings across 98 symbols — `financial services, basic
materials, industrials, consumer defensive, consumer cyclical, healthcare,
utilities, energy, technology, real estate, communication services`. **All 11 are
direct keys in `SECTOR_PE_NORM`. Zero unmapped, zero unknown.** One row (1/98) has
a NULL sector; that path returns `mappingStatus: "missing"` and omits the P/E
component — no made-up default, consistent with the source comment and with §2 of
the diagnosis.

§7's claim survives at larger n: India taxonomy coverage is effectively 100%
`direct`. **This is exactly why R4 bites India harder than the US.** The US path
loses ~18% of rows to `omitted_unmapped_sector` — those rows never touch the biased
table. India's coverage is complete, so essentially every scored NSE name with a
positive P/E is priced against a US benchmark.

---

## 6. Verdict

**Promote R4 from LOW to MEDIUM. Do not promote to HIGH.**

What promotes it:

- The evidence base is **405 rows / 45 symbols**, not 23. The stated reason for the
  LOW rating ("only 23 India rows carry the corrected evidence") is factually
  obsolete.
- The bias is **large, directional, and per-sector**: 0.64× to 2.59×, a 4.0× spread.
  This is a genuine unit/reference-class mismatch, exactly the failure the Scoring
  Data-Truth Protocol §3 exists to catch. It is not a tuning quibble.
- It **changes the P/E component on 59% of India rows**, by up to 30 of the ~68
  points of range `scoreFundamentals` can move.
- India taxonomy coverage is 100% `direct`, so nothing shields India from it — the
  US is partially shielded by its 18% unmapped rate.
- The two sectors where the norm is most wrong in the *generous* direction (energy
  0.69×, technology 0.64×) are producing 89 of the 159 top-band bonuses. The value
  component is currently rewarding sector membership, not cheapness.

What holds it below HIGH:

- **Net admission effect is +4 rows on 405 (74.6% → 75.6%).** R4 does not explain
  India's high pass rate and correcting it will not lower it. Anyone hoping this is
  the discrimination fix should read the flip table and stop.
- Only **18/405 rows (4.4%)** cross the gate at all; the knife-edge cohort is
  26 rows (6.4%). The clamp and the top-coding absorb most of the movement — which
  is itself a symptom of the *additive-asymmetry* problem the diagnosis identifies
  as the real driver.
- Per §8 of the diagnosis, `analyst_score` has IC ≈ 0 on India. Correcting an input
  to a score that does not yet rank forward returns improves *correctness*, not
  *performance*. Claiming otherwise would be unfalsifiable.
- **The remedy is not yet implementable.** `india_screen_cache` keeps one overwritten
  snapshot (98 rows, one day, per-sector n = 2–21). Hard-coding today's medians
  would replace a wrong constant with a noisy constant — and a look-ahead one, since
  a benchmark computed from today's snapshot cannot be applied to July decisions.

Framing: R4 is a **correctness defect in a money-path input**, not a lever on the
74% pass rate. It should be fixed because a US median applied to an NSE name is
indefensible on its face, not because it will move admissions.

### Proposal (NOT approved — owner sign-off required before any code moves)

Sequencing matters more than the fix:

1. **Prerequisite, non-scoring:** retain `india_screen_cache` history (append with
   `scored_at` rather than overwrite, or snapshot to a sibling table). Without ≥30
   trading days of NSE sector P/E history there is no benchmark that is both stable
   and free of look-ahead. This is the blocking item, and it changes no scorer.
2. Only then: key the benchmark by market — `resolveSectorPeBenchmark(sector,
   taxonomy, market)` reading a rolling trailing-window India median, with the
   existing US table unchanged as the US branch and an explicit `mappingStatus`
   for "India norm not yet available" that **omits** the component rather than
   falling back to the US number. Fallback to the US table would silently
   reintroduce exactly the defect being fixed.
3. Ship behind the frozen counterfactual above, re-run on the then-current row set,
   and require the US cohort to be byte-identical.
4. Do **not** bundle this with R5 (US insider/macro level terms) — the diagnosis
   already warns those would confound the same observation window.

Nothing in this document has been implemented, and no remedy is approved.

### Query provenance

All figures from `mcp__supabase-Kairos__execute_sql` against project
`dionkikgdmlaotvtbnfr` on 2026-08-03, read-only `SELECT` only. Sources:
`decision_observations` (features/weights/scores/threshold, market='india'),
`india_screen_cache` (NSE P/E + sector, snapshot 2026-08-03),
`information_schema.columns`. Scorer semantics read from
`lib/data/scores.ts:59-213` and `:500-580`.
