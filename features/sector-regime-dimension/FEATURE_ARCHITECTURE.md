# Sector-by-regime dimension

> Status: **DRAFT — awaiting approval. BLOCKED on a data prerequisite (§3).**
> Created: 2026-09-02
> Scope: a new cross-sectional scoring input. Money path if promoted; measure-only first.

## 1. Why this is the only macro idea worth building

`macro` is one market-wide scalar per day. Its rank IC is exactly `0.0000` **by
construction** — a constant has no cross-sectional variance, so it cannot rank
one candidate above another. Everything EPB Research and Bravos Research
publish, and everything Smart X Terminal charts, is *also* a market-wide series:
adding the Cyclical Economy index, HY spreads or an oil model makes that scalar
better informed and it will still rank nothing. Those belong in the Stage-2
regime policy (`features/macro-dimension-role`), not in the composite.

Sector is different. **Sector varies per symbol.** A dimension of the form
"how does this symbol's sector behave in the current regime" is the first macro
input that could actually order a cross-section — which is the only way macro
earns a place in the weighted score rather than acting as a hidden market timer.

## 2. The measure

For each symbol on each session:

```
sector_regime_score(symbol, date)
  = f( relative strength of symbol's sector vs the market,
       conditioned on the macro regime phase on that date )
```

Sector relative strength comes from the sector ETFs already prewarmed daily by
`price-cache-fill` (XLK, XLF, XLE, XLV, XLI, XLY, XLC, XLP, XLU, XLRE, XLB).
Regime phase comes from the existing `macro_regime` row. Neither needs a new
provider.

## 3. BLOCKER — the symbol→sector mapping is not fit for this

Measured 2026-09-02, and this is why the feature cannot start today:

| fact | value |
|---|---|
| US symbols with a decision observation | **162** |
| of those, symbols carrying a sector in `symbol_profiles` | **68 (42%)** |
| distinct sector labels across 82 profiled symbols | **23** |
| median symbols per label | **~2** |
| `sector_breadth_history` rows / sectors / days | **14 / 2 / 11** |

Two independent defects:

**Coverage.** 58% of the US cross-section has no sector at all. Under the
availability-mask contract such a symbol is excluded, so the dimension would
score a minority of the book and the score would renormalize around its absence
for everyone else — the exact shape that makes a dimension look available when
it is not.

**Taxonomy.** The 23 labels sit at mixed levels of granularity:
`Semiconductors` (15) and `Technology` (12) coexist, so an identical chip maker
can land in either; `Banking` (2) and `Financial Services` (7) split one GICS
sector; `Communications` (2), `Telecommunication` (3) and `Media` (2) are three
names for one. `normalizeSector` in `lib/scoring/rank.ts` only lowercases and
trims — it performs no mapping, so these remain distinct groups.

`sector_breadth_history` exists but holds 14 rows across 2 sectors and 11 days.
It is not a usable input.

### 3.1 This already degrades a feature we shipped

`rank.ts` partitions the cross-section into `market × asset-type × sector`
groups and requires `RANK_MIN_GROUP_EQUITY_US = 20` members, falling back to a
market-wide `:all` group when a sector group is thinner. With a median of ~2
symbols per label, **essentially every sector group falls below 20 and collapses
into the fallback.** So the "cross-sectional rank" gate — the Stage-3 change
recommended as the highest-leverage available — would not actually be ranking
within sectors today. It would be ranking against the whole market while
reporting a sector-partitioned design.

That is worth verifying independently before Stage 3 is enabled, and it is a
second reason to fix the taxonomy first.

### 3.2 RE-MEASURED 2026-09-09 — the taxonomy fix shipped; the blocker moved

The taxonomy defect described above **is fixed.** `normalizeSector` in
`lib/scoring/rank.ts` now delegates to `canonicalSectorKey`
(`lib/scoring/sector-taxonomy.ts`), which maps provider labels to canonical
GICS sectors and returns `null` for unmapped labels so they take the honest
fallback rather than a wrong peer group. The §3 text above describing
`normalizeSector` as "lowercase and trim only" is historical — kept for the
record, no longer true.

Coverage also improved materially:

| fact | 2026-09-02 | 2026-09-09 |
|---|---|---|
| US symbols with a decision observation | 162 | 167 |
| of those, carrying a sector in `symbol_profiles` | 68 (42%) | **117 (70%)** |
| distinct RAW sector labels | 23 | 30 |

**But the blocker is still real, and its cause has moved from code to
universe breadth.** Applying the now-live crosswalk to current production
labels, all-time distinct US symbols per canonical sector:

| canonical sector | members | vs. `RANK_MIN_GROUP_EQUITY_US = 20` |
|---|---|---|
| Technology (17 `Technology` + 15 `Semiconductors`) | **32** | clears |
| Financials (12 `Financial Services` + 2 `Banking`) | 14 | below |
| Consumer Discretionary (9 `Retail` + 4 `Hotels, Restaurants & Leisure`) | 13 | below |
| Energy | 11 | below |
| Communication Services (`Media`) | 6 | below |
| Health Care (3 `Biotechnology` + 2 `Life Sciences Tools & Services`) | 5 | below |
| Materials (`Metals & Mining`) | 5 | below |
| Real Estate | 3 | below |
| Utilities | 3 | below |
| Industrials (`Electrical Equipment`) | 3 | below |
| Consumer Staples (`Beverages`) | 2 | below |

**One sector of eleven clears the floor.** The other ten still collapse into
`market:assetType:all`, exactly as §3.1 describes — but now because the
universe is too small and too tech-concentrated, not because the mapping is
broken.

This count is also the OPTIMISTIC case: it is all-time distinct symbols with
any observation. `rank.ts` partitions on **per-session eligible** counts,
which are strictly smaller, so on a given session even Technology may not
clear.

Consequence for this feature: sector-relative ranking cannot be meaningfully
evaluated today for ten of eleven sectors, regardless of the taxonomy fix.
The remaining options are a materially wider universe, a lower floor for thin
sectors (which trades away the statistical protection the floor exists to
provide, and would need its own justification), or accepting that the
dimension only ever applies to Technology. None of these is a code defect to
fix.

### 3.3 The shadow has never run and cannot be surfaced today

Verified 2026-09-09:

- **No schedule.** No `cron.job` entry, nothing in `vercel.json`, nothing in
  `lib/schedule.ts`.
- **No persistence.** `app/api/agents/sector-regime-shadow/route.ts` only
  reads (`observation_labels`, `symbol_profiles`, `price_cache`). It writes
  nothing; its IC report is returned in the HTTP response and discarded.
- **No results table** exists for it.

So "run the shadow and surface it on Upgrade Path" requires adding
persistence and a schedule first — it is not merely a matter of invoking the
route. Given §3.2, doing so before the breadth problem is resolved would
persist an IC computed over one usable sector.

## 4. Staged plan

**Stage 0 — mapping (prerequisite, no scoring change).** One canonical sector
per symbol at a single level of granularity (GICS sector, 11 buckets), covering
the traded universe, with the source and as-of date recorded. `symbol_profiles`
already has `sector` and `industry` columns to hold it. `normalizeSector` gains
a real mapping so `Semiconductors → Technology`, `Banking → Financial Services`,
`Telecommunication/Media → Communication Services`. Success is measured, not
assumed: coverage of decision symbols and count of distinct labels, both
reported.

**Stage 1 — measure only.** Compute the sector-regime score for history and run
it through the diagnostics shipped today (rank IC, quantile gradient, spread
with `nEffective`, rank autocorrelation). No weight, no eligibility effect.

**Stage 2 — decide.** Only with evidence clearing the pre-declared floors, and
only as a governed promotion.

## 5. The statistical trap this must not fall into

A sector signal assigns the **same value to every symbol in a sector**. With 11
GICS sectors, a 78-name cross-section carries at most **11 distinct values**, not
78. Its effective breadth is the number of sectors, not the number of names.

Rank IC computed over 78 names would therefore overstate the independent
information: the 78 observations are ~11 clusters, and the correction is the
same in spirit as the `nEffective` overlap correction already applied across
time. **Breadth must be corrected across the cross-section as well as across
sessions**, or a sector bet will look far more significant than it is — the
identical error to the naive t of 3.09 versus the corrected 1.38 measured on
technical Q1 today.

This is the single easiest way for this feature to produce a false positive, and
it must be built in from the first measurement rather than discovered later.

## 6. Honest prior

This may simply reproduce what `technical` already captures. Sector relative
strength IS a momentum measure, and technical's rank IC is currently negative at
every horizon with its bottom quintile the best performer. A sector-momentum
dimension could be a slower-moving copy of a signal that is currently ranking
backwards. Stage 1 must therefore report the **correlation between the
sector-regime score and the existing technical score**, and a high correlation is
a reason to stop, not a detail.

## 7. Not in scope

Adding EPB/Bravos market-wide series to the composite (they cannot rank —
see §1); any change to weights, thresholds or eligibility; any new data
provider. Sector ETFs and `macro_regime` already exist.
