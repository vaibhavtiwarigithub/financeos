# Sector Relative Strength — SUPERSEDED

> Status: **WITHDRAWN 2026-09-09.** Do not implement this document.
> Superseded by `features/sector-regime-dimension/FEATURE_ARCHITECTURE.md`,
> which already covers this idea with a more rigorous evidence path.

---

## Why this document was withdrawn

It proposed building sector relative strength into `EdgeScout` as a 4th
admission z-score. That was wrong on three counts, all found in review:

1. **It claimed sector-ETF relative strength did not exist.** It does:
   `lib/learning/sector-regime.ts` (`sectorRelativeStrength`) computes each
   sector ETF's trailing return minus SPY, strictly point-in-time, and
   `app/api/agents/sector-regime-shadow/route.ts` maps all 11 GICS sectors to
   their SPDRs and joins them to eligible long decisions. Building a second
   implementation inside EdgeScout would have been duplicate machinery that
   could silently drift from the first.

2. **It claimed per-symbol sector classification was ready.** It is not. See
   `sector-regime-dimension` §3 — the blocker is coverage and taxonomy, not
   the strength calculation. The withdrawn document generalized from a
   5-symbol convenience sample.

3. **It treated an EdgeScout admission change as low-risk.** Admission is not
   measure-only: changing it changes which symbols `ResearchAgent` ever sees,
   which changes what the learner subsequently learns from. That belongs
   behind an admission shadow, not a "small additive term."

## Measured update to the blocker (2026-09-09)

`sector-regime-dimension` §3 measured the blocker on 2026-09-02. Re-measured
today against production:

| fact | 2026-09-02 | 2026-09-09 |
|---|---|---|
| US symbols with a decision observation | 162 | 167 |
| of those, carrying a sector in `symbol_profiles` | 68 (42%) | **117 (70%)** |
| distinct sector labels | 23 | **30** |

Coverage improved substantially. **Taxonomy fragmentation got worse** — 30
labels now describe what should be 11 sectors. The §3 blocker stands, and its
taxonomy half has regressed since it was written.

Note that `lib/scoring/sector-taxonomy.ts` already contains a working
crosswalk that normalizes provider strings into 11 canonical sectors — it is
already used by `resolveSectorPeBenchmark` for P/E benchmarking. The blocker
is that `normalizeSector` in `lib/scoring/rank.ts` does not use it; it only
lowercases and trims. The mapping largely exists; it is not wired into the
path that needs it.

## Additional finding — the shadow has never run

Beyond the review's corrections, verified 2026-09-09:

- **No schedule.** No `cron.job` entry, nothing in `vercel.json`, nothing in
  `lib/schedule.ts`.
- **No persistence.** `sector-regime-shadow/route.ts` only reads
  (`observation_labels`, `symbol_profiles`, `price_cache`). It writes
  nothing. Its IC report is returned in the HTTP response and discarded.
- **Therefore it cannot be surfaced on Upgrade Path today** — there is no
  standing evidence to surface. "Run and surface the existing shadow"
  requires adding persistence and a schedule first.

## Agreed sequencing (owner-directed, 2026-09-09)

1. Fix the symbol→sector taxonomy blocker — wire `rank.ts`'s
   `normalizeSector` to the existing `sector-taxonomy.ts` crosswalk so 30
   labels collapse to 11 canonical sectors. This also un-breaks the
   cross-sectional rank gate described in §3.1, which currently falls back
   to market-wide ranking while reporting a sector-partitioned design.
2. Add persistence + a schedule to the sector-regime shadow so it produces
   standing evidence.
3. Surface it on Upgrade Path.
4. Require the **sector-level** IC — not the inflated name-level IC — to be
   positive, robust, and meaningfully distinct from the existing technical
   score's momentum.
5. Only if that clears: an admission shadow comparing EdgeScout's top-four
   with and without sector strength, because admission is not measure-only.
6. Only after that: a small bounded admission boost with a rollback switch.

Nothing in steps 1-5 touches the money path.
