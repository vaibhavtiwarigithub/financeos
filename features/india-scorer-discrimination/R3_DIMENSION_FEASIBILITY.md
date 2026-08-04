# R3 — Can India get a real third/fourth scoring dimension?

Status: **Feasibility study only. READ-ONLY. Nothing approved, nothing implemented.**
No scorer, weight, config, dimension, threshold or migration was changed. No row was written.

Date: 2026-08-03
Protocol: `CLAUDE.md` §"Scoring Data-Truth Review Protocol"
Evidence: production Postgres (Supabase `dionkikgdmlaotvtbnfr`), read-only `execute_sql`, plus source.
Follows from: `features/india-scorer-discrimination/DIAGNOSIS.md` §3d, §5, §11/R3, §14.

---

## 0. Verdict up front

**Neither candidate is a viable scoring dimension today. Do not add either.**

| Candidate | Per-date cross-sectional σ across symbols | Verdict |
|---|---|---|
| **NSE FII/DII flows** (`lib/india-macro.ts`) | **0.00, by construction** — one national ₹-crore figure per session, identical for all 41 symbols | **Would be a constant.** Exactly the §14 anti-pattern, and worse than US macro (σ 2.26 > 0). |
| **GDELT news tone** (`lib/india-news.ts`) | **Unmeasurable — zero production rows.** The scoring path was retired; `sentiment.news` is `unsupported` for India in `lib/evidence/intent-classification.ts:99` | **Needs a different data shape.** No production evidence exists to test it with. |
| *(measured as the live stand-in)* **Google News RSS shadow** | Non-zero (CV 0.59–0.73 per date) — but **97.5% of it is a permanent symbol fixed effect** | **Would be a static universe tilt**, not a signal. And it carries no tone field at all. |

The one honest positive: adding a third dimension would move India off the 2-dimension
abstain floor (§3d). That is a *robustness* win only. It buys nothing for discrimination,
and both candidates buy it by moving the composite level — i.e. **each is a threshold
change wearing a coverage fix's clothes**, the same trap §14c identified for US insider.

---

## 1. Baseline being perturbed

Primary window, `market='india' AND scoring_version='v1.0' AND ts >= '2026-07-20'`:

| metric | value |
|---|---:|
| rows / dates / symbols | 347 / 13 / 41 |
| mean composite | 75.14 |
| σ composite | 17.76 |
| mean `fundamental_score` | 81.08 |
| mean `technical_score` | 68.01 |
| pass ≥ 60 | 255 (**73.5%**) |
| within ±2 points of 60 | 20 (5.8%) |
| included dims | fundamental + technical on 100% of rows |

Applied weights today: `fundamental` 0.5455 / `technical` 0.4545 (base balanced profile
`{F .30, T .25, S .20, M .15, I .10}` from `lib/research-agent.ts:1706`, renormalised over
the two available dims). Check: `0.5455×81.08 + 0.4545×68.01 = 75.14` ✓ — the level shift
arithmetic below is anchored to reproduced production numbers, not assumed ones.

---

## 2. Candidate A — NSE FII/DII flows (`lib/india-macro.ts`)

### 2a. Coverage — nothing is persisted, so there is no coverage to measure

| check | result |
|---|---|
| `provider_call_ledger` rows for the NSE FII/DII fetch, last 60d | **0** |
| `evidence_cache_v2` rows, market='india', any FII/DII intent | **0** |
| `decision_observations.features` containing `fii` (347 India rows) | **0** |
| dedicated table | none exists |

`fetchFiiDiiFlows()` (`lib/india-macro.ts:63`) runs inside `processSymbol`
(`lib/research-agent.ts:1537`) behind a 30-minute in-process memo, and routes through
`providerCachedFetch` under the **`gdelt` free bucket** (`lib/india-macro.ts:74`) because
NSE has no provider id of its own. That path writes no ledger row, so the source has
**zero production observability**: we cannot state its India-trading-day hit rate, its lag,
or how often NSE's anti-bot/geo gate blocks it from Vercel. The module itself documents
that NSE "geo-throttles some datacenter IPs" and fails soft to `null` at every step.

Freshness ceiling by construction: NSE's `fiidiiTradeReact` carries the **latest completed
session's provisional** figure, published post-close. On a same-day pre-open research run
it is T-1 at best.

### 2b. Cross-sectional variance — zero, and provably so

The endpoint returns **one FII net and one DII net per session for the whole cash market**
(`FiiDiiSession { date, fiiNet, diiNet }`, `lib/india-macro.ts:27-31`). There is no symbol
dimension in the payload. Whatever mapping `f(fiiNet, diiNet) → 0..100` is chosen, every
symbol on a given date receives **the identical value**:

> **per-date σ across symbols = 0.00, exactly, on every date, by construction.**

This is strictly worse than the US `macro_score` that §5 already indicts (σ 2.26, range
57–62). US macro at least varies slightly across dates within a scored window; a single
national flow number varies across dates but is **perfectly rank-preserving within any
date** — it cannot reorder two Indian names, ever.

DIAGNOSIS.md §11/R3 already flagged this as a caution. **Production confirms it and the
caution should be upgraded to a rejection.**

### 2c. Where it flows today

Thesis narrative only. `fiiDiiMacroLine(fiiDii)` produces `indiaMacroLine`
(`lib/research-agent.ts:1544`), a grounding sentence for the LLM thesis prompt. It never
touches `macro_score`; `fetchMacroScore` hard-returns `available:false` for India
(`lib/data/scores.ts:373`) with an explicit comment that wiring FII/DII in "is a separate
approved build, NOT this fix". `macro.regime_inputs` has **no** India entry in
`INTENT_CLASSIFICATION` (`lib/evidence/intent-classification.ts:117-127`). Also surfaced
read-only at `app/api/india/fii-dii/route.ts` and `app/api/india/smart-money/route.ts`.

### 2d. Cost to score it, if it were viable

Files: `lib/data/scores.ts` (replace the India early-return in `fetchMacroScore` with a
scored branch + a real availability signal), `lib/evidence/intent-classification.ts`
(add `india: "score_affecting"` to `macro.regime_inputs`), `lib/research-agent.ts`
(`applicableDimensions` must add `macro` for India), plus a persistence layer that does not
exist — `macro_regime` has **no `market` column**, which is the exact reason the India
macro read was cut. So this is a migration, not a wiring change.

Renormalisation itself needs **no** work: `computeWeightedAnalystScore` renormalises over
whatever `includedDims` contains and already handled 3-dim India during the 07-13→07-17
leak window (§3c). The machinery is not the obstacle.

### 2e. Composite level shift — this is a threshold change

Three included dims → weights `F .4286 / T .3571 / M .2143`. Read-only reconstruction over
the 347 production rows, sweeping the market-wide macro value `X`:

| X (market-wide macro score) | mean composite | pass ≥60 | vs 73.5% baseline |
|---:|---:|---:|---:|
| 30 | 65.5 | 62.2% | −11.3pp |
| 40 | 67.6 | 66.6% | −6.9pp |
| 50 | 69.8 | 71.2% | −2.3pp |
| 60 | 71.9 | 73.2% | −0.3pp |
| 70 | 74.0 | 77.5% | +4.0pp |
| 80 | 76.2 | 83.0% | +9.5pp |
| 90 | 78.3 | 91.4% | +17.9pp |

Sensitivity: **2.14 composite points per 10 points of X**. Against §14e's finding that the
gate is knife-edge, this means **the entire India book's admission is re-decided each day by
one national flow number**. Every name moves the same direction by the same amount — a
market-timing overlay bolted onto a stock scorer, not a dimension. Reject.

---

## 3. Candidate B — GDELT news sentiment (`lib/india-news.ts`)

### 3a. It was built, scored, and already retired

`lib/india-news.ts` is intact and does produce a per-symbol 0–100 score from GDELT's
`tonechart` histogram (`toneToScore`, ≥3 toned articles required). But:

- `classifyIntent("sentiment.news", "india") === "unsupported"`
  (`lib/evidence/intent-classification.ts:96-101`), noted in-source as *"India GDELT scoring
  was retired; replacement news/event evidence has separate shadow-only intents."*
- `tests/india-sentiment-retired.test.ts` **pins** the retirement: `lib/research-agent.ts`
  must not contain `fetchIndiaNewsSentiment`, and the India branch must not
  `dims.add("sentiment")`.
- Production: **0** of 347 India `decision_observations` rows carry `gdelt` or `tone` in
  `features`. **0** `evidence_cache_v2` or `provider_call_ledger` rows for a GDELT intent.

So the per-date cross-sectional σ of GDELT tone for India is **unmeasurable from
production** — there is nothing to measure. Reviving it means re-running the fetch as a
shadow first, not wiring it to a weight.

### 3b. The live replacement — Google News RSS shadow — and its variance

The current India news evidence is the shadow at `app/api/agents/india-news-shadow/route.ts`
(cron `kairos-india-news-shadow`, migration `20260731210000_…`), which fetches Google News
RSS headlines.

**Coverage** (`provider_call_ledger`, intent `sentiment.news_headlines_shadow`):

| metric | value |
|---|---|
| calls | 48 |
| dates | 4 (2026-07-31 → 2026-08-03) |
| symbols | 12 of 41 India symbols (**29%**; `MAX_SYMBOLS = 20`) |
| transport success | **48/48 = 100%** (all HTTP 200) |
| lag | intraday, same day |

Genuinely healthy fetch — but **4 days old and 29% of the universe**. Against DIAGNOSIS's
own bar for acting on India (§11/R6: ≥20 independent post-fix dates), this is nowhere near
enough to weight anything.

**Per-date cross-sectional dispersion**, using response volume (the only per-symbol
quantity with 4 dates of history; `evidence_cache_v2` is an upsert and retains only the
latest snapshot):

| date | n | mean bytes | **σ across symbols** | CV | min | max |
|---|--:|--:|--:|--:|--:|--:|
| 2026-07-31 | 12 | 51,829 | **37,944** | 0.732 | 3,674 | 121,207 |
| 2026-08-01 | 12 | 50,601 | **36,424** | 0.720 | 3,663 | 117,621 |
| 2026-08-02 | 12 | 48,684 | **33,334** | 0.685 | 6,062 | 106,517 |
| 2026-08-03 | 12 | 47,938 | **28,491** | 0.594 | 7,561 | 91,082 |

Per-date σ is large — this is **not** a market-wide constant. But that is not the same as
being a signal. Decompose the per-date z-score by symbol:

| symbol | mean bytes | **mean z (cross-sectional)** | **σ of z over the 4 dates** |
|---|--:|--:|--:|
| TCS.NS | 109,107 | +1.73 | 0.151 |
| WIPRO.NS | 82,278 | +0.93 | 0.270 |
| LODHA.NS | 78,188 | +0.84 | 0.087 |
| HCLTECH.NS | 66,602 | +0.50 | 0.116 |
| TITAN.NS | 65,892 | +0.49 | 0.253 |
| PFC.NS | 63,070 | +0.39 | 0.024 |
| BAJAJ-AUTO.NS | 58,170 | +0.26 | 0.142 |
| NAUKRI.NS | 23,461 | −0.75 | 0.314 |
| TECHM.NS | 16,633 | −0.99 | 0.152 |
| ICICIBANK.NS | 14,744 | −1.04 | 0.112 |
| SUNPHARMA.NS | 13,770 | −1.06 | 0.068 |
| HEROMOTOCO.NS | 5,240 | −1.31 | 0.070 |

Variance decomposition of the cross-sectional z (total variance = 1.00 by construction):

- **between-symbol** (variance of the per-symbol mean z): **0.976**
- **within-symbol over time** (mean σ_z 0.157): **0.025**

> **≈97.5% of the cross-sectional dispersion is a permanent symbol fixed effect.**

TCS is the loudest name every single day; HEROMOTOCO the quietest every single day. Scoring
this ranks the universe by *press coverage volume*, which is a proxy for market cap and
sector, and re-imposes that same ranking daily. It would not be a constant across symbols —
it would be a **constant per symbol**, which is arguably worse: a silent, permanent tilt
toward large-cap IT that never updates and never reverses.

Two further disqualifiers:

1. **No tone field.** `parseGoogleNewsRss` (`lib/india-news-shadow.ts`) yields
   `{title, source, publishedAt, url}` only. There is no sentiment number in this feed at
   all. Producing one needs an LLM or lexicon pass that does not exist — a new provider
   cost, on 41 symbols × every research run.
2. **Top-coded at 10.** `if (result.length >= 10) break;`. On 2026-08-03, headline counts
   were `10,10,10,10,10,10,10, 4, 2, 2, 1, 1` — **7 of 12 (58%) at the ceiling.** That is
   the same saturation defect §5 already indicts in `technical_score`. Adding a second
   ceiling-bound input to a composite that is already bimodal makes the shape worse.

### 3c. Where it flows today

Nowhere near the score. The shadow writes `evidence_cache_v2` (`intent =
sentiment.news_headlines_shadow`, provider `google_news_rss`) and `provider_call_ledger`
only. It is not read by `research-agent.ts`, not in `availability_mask`, not in
`features->'weighting'->'included_dims'`, not displayed. The companion
`event.corporate_announcement_shadow` (NSE, 12 symbols, 4 calls, 3 OK) is likewise shadow-only.

### 3d. Cost to score it

Materially larger than Candidate A:

- a tone/sentiment extraction step that does not exist (LLM or lexicon) — new per-symbol
  per-run cost, or revive `lib/india-news.ts`'s GDELT tonechart and delete the retirement
  test;
- flip `sentiment.news` (or a new intent) to `score_affecting` for India in
  `lib/evidence/intent-classification.ts`, and delete/rewrite
  `tests/india-sentiment-retired.test.ts` — a test that exists precisely to force this
  confrontation;
- `applicableDimensions` + the `!india` guard on `fetchSocialSentiment`
  (`lib/research-agent.ts:1489`);
- widen the shadow past `MAX_SYMBOLS = 20` to cover all 41 India symbols.

Renormalisation again needs nothing.

### 3e. Composite level shift

Three dims `F .40 / T .3333 / S .2667`:

| X (sentiment score) | mean composite | pass ≥60 | vs 73.5% |
|---:|---:|---:|---:|
| 30 | 63.1 | 60.2% | −13.3pp |
| 40 | 65.8 | 66.0% | −7.5pp |
| 50 | 68.4 | 71.2% | −2.3pp |
| 60 | 71.1 | 73.2% | −0.3pp |
| 70 | 73.8 | 80.1% | +6.6pp |
| 80 | 76.4 | 89.9% | +16.4pp |
| 90 | 79.1 | 93.1% | +19.6pp |

Sensitivity **2.67 composite points per 10 points of X** — sentiment carries *more* weight
(0.2667) than macro would (0.2143), so it is the larger threshold move of the two.

Note the neutral point in both tables: the shift is zero only where `X ≈ 75.1`, i.e. where
the new dimension happens to score at India's existing composite mean. Any dimension that
scores India's names near a neutral 50 **lowers** the composite by ~5–7 points and cuts
admission. That is not a scorer fix — it is R6 (raise the India threshold), which
DIAGNOSIS.md §11 explicitly recommends against, arriving through the back door.

---

## 4. If neither works, what would

The requirement is a source that is (a) **per-symbol**, (b) **time-varying within symbol**,
and (c) **not a proxy for size**. Three candidates already exist in `lib/nse-data.ts` and
none is in the shadow:

| source | function | per-symbol? | time-varying? | state |
|---|---|---|---|---|
| NSE block/bulk deals | `fetchNseBigDeals` (`lib/nse-data.ts:205`) | yes | yes — episodic by nature | wired to `app/api/india/smart-money` display only. **Never measured for scoring.** Best untested candidate. |
| NSE single-stock option chain / PCR | `fetchNseOptionChain` (`lib/nse-data.ts:156`) | yes | yes, daily | display only (`app/api/india/options`). NSE has F&O on ~180 names — coverage against the 41-symbol book is unmeasured. |
| SEBI PIT insider | `fetchNseInsider` (`lib/nse-data.ts:75`) | yes | yes | **Already tested and rejected on live evidence.** See below. |

**SEBI PIT is closed — do not re-open it.** `tests/india-insider-not-wired.test.ts` records
measurement against NSE `/api/corporates-pit` over 34 live India symbols (2026-07-17):
90-day coverage **2/34 = 6%**; symbols meeting the US bar of ≥3 open-market txns in 90d
**0/34 = 0%**; and only ~30% of PIT rows are open-market at all (the rest ESOP allotments,
off-market, gifts, pledges) — a same-named field with different meaning across markets.
Worth flagging separately: `insider.transactions` is nonetheless declared
`india: "score_affecting"` in `lib/evidence/intent-classification.ts:105` while production
availability is 0.0% (§3a). That is a **stale contract declaration**, not a live defect —
noted, not changed.

**The lazy correct next step is a shadow, not a dimension.** Extend the existing
`india-news-shadow` cron pattern to `fetchNseBigDeals` (and optionally the option chain),
persist per-symbol per-date values under a shadow-only intent for ~20 India trading days,
then re-run exactly the measurement in §3b: per-date σ, and the between/within variance
split. If within-symbol variance is not a large share of the total, that candidate dies the
same way this one did — for ~40 lines of route code and zero money-path risk.

---

## 5. What this does not resolve

India remains at exactly 2 included dimensions on 100% of rows, one Yahoo outage from
book-wide abstention (§3d). That fragility is real and neither candidate fixes it honestly —
both would paper over it with a term carrying no cross-sectional information, purchased at
the price of a 2.1–2.7 point-per-10 composite level move on a knife-edge gate.

DIAGNOSIS.md's sequencing (R2 → R1 → R3 → R4) still holds and this study reinforces it:
**R3 should be deferred behind R2 and R1.** Fixing the saturating `technical_score` (R2) and
making the gate relative (R1) both improve ordering without adding a dimension. R3's own
required evidence — non-degenerate cross-sectional variance — is not satisfiable by either
named candidate on current production data.

---

## 6. Evidence log

All queries read-only via `mcp__supabase-Kairos__execute_sql`, project `dionkikgdmlaotvtbnfr`.

| # | Query | Result used in |
|---|---|---|
| 1 | `evidence_cache_v2` grouped by intent/provider, market='india' | §2a, §3b coverage |
| 2 | `information_schema.tables` scan for fii/macro/news/sentiment/shadow/provider | §2a (no FII table) |
| 3 | `macro_signals` indicators + date range | §2c (all 8 are US FRED series) |
| 4 | `provider_call_ledger` by provider/intent/market, 60d, india + nse/gdelt/google | §2a (0 FII rows), §3b (48/48 OK) |
| 5 | `provider_call_ledger` per-date/per-symbol response_bytes, news shadow | §3b per-date σ table |
| 6 | z-score decomposition of (5) by symbol | §3b between/within split |
| 7 | `decision_observations.features` ILIKE fii/gdelt/tone, India v1.0 ≥07-20 | §2c, §3a (0/347 each) |
| 8 | India baseline: n, dates, symbols, mean/σ, dim means, pass ≥60, ±2 band | §1 |
| 9 | Parametric reconstruction of 3-dim composites over sweep of X | §2e, §3e |

Source read (no edits): `lib/india-macro.ts`, `lib/india-news.ts`, `lib/india-news-shadow.ts`,
`lib/data/scores.ts`, `lib/research-agent.ts`, `lib/nse-data.ts`,
`lib/evidence/intent-classification.ts`, `app/api/agents/india-news-shadow/route.ts`,
`tests/india-sentiment-retired.test.ts`, `tests/india-insider-not-wired.test.ts`,
`supabase/migrations/20260731210000_market_local_crons_and_india_news_shadow.sql`.
