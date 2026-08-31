# Sector scoring integrity — cyclicals, macro weighting, and dead scoring code

> Status: **REVISION 2 — DRAFT. F1 and F2 returned for revision by independent review.
> F3 approved in principle, awaiting owner go-ahead to implement. No code written.**
> Date: 2026-08-29. Influence if approved: money path (`analyst_score` → direction gate → paper buys).
>
> Review record: `docs/audits/2026-08-29-sector-scoring-codex-brief.md` (request) and the
> independent verdict of 2026-08-29, which found two of revision 1's stated mechanisms did
> not match the live implementation. Both are corrected below and the corrections change
> the recommendations, not just the wording.

## The live scoring path (verified)

```
research-agent.ts:1711  computeScores()            <- deterministic, sole producer
  |- lib/data/scores.ts:589  scoreFundamentals()
  |    |- :103  resolveSectorPeBenchmark() -> :70  SECTOR_PE_NORM
  |- fetchMacroScore(supabase, market, now)        <- no symbol parameter
  |- scoreTechnicals / scoreSentiment / normalizeInsiderScore
-> research-agent.ts:1861  weightOf = applyStrategyTilt({fw,tw,sw,mw,iw}, strategy_preference)
-> research-agent.ts:1869  computeWeightedAnalystScore(scoreOf, included, weightOf)
-> analyst_score -> entry_eligible -> proposals
```

**Corrected in revision 2:** live base weights come from the risk-profile / champion
mandate (`fw/tw/sw/mw/iw`) passed through `applyStrategyTilt`, **not** from
`lib/scoring/archetypes.ts`. Revision 1 quoted archetype weights as the live baseline and
was wrong. Production records show a normal US macro weight of **15%**, not the 10% quoted
previously. `archetypes.ts` weights belong to the shadow arms, not the live scorer.

Confirmed: there is exactly one producer of `decision_observations`; 6,494 rows carry
`deterministic_v1/v1.0`. The 210 older untagged rows stay historical and are not
reinterpreted (frozen-history rule).

---

## F1 — Semiconductors fold into `technology`, and P/E is an ADDITIVE adjustment

`lib/data/scores.ts:82` maps `semiconductors -> technology`; `SECTOR_PE_NORM.technology = 30`.

**Corrected mechanism.** Inside `scoreFundamentals`, P/E is not a normalised component. It
is an additive adjustment to a running score, keyed on `ratio = pe / norm`:

| ratio | adjustment |
|---|---:|
| < 0.7 | **+18** |
| < 1.0 | +8 |
| < 1.4 | -3 |
| < 2.0 | -12 |
| >= 2.0 | **-22** |

Renormalisation happens only between the five **top-level dimensions** in
`weighted-score.ts`. Nothing renormalises inside the fundamental dimension.

**This invalidates revision 1's F1-b.** That option claimed removing the P/E term would let
"the availability mask renormalise the remaining fundamental inputs". No such mechanism
exists. Removing the term simply deletes its adjustment — which for an expensive name
(ratio >= 2.0) **raises** the fundamental score by 22 points. Revision 1 presented this as
a conservative de-risking move; it is in fact a large score change in a direction nobody
measured, and it would have made expensive semiconductors score *better*.

Measured production reach. **Re-verified independently 2026-08-31** once the Supabase
connection returned; figures below are mine, with the review's in brackets where they
differ. The filter is `features->'fundamental'->>'sector' ILIKE '%semiconduct%'` on US rows.

| metric | verified | review |
|---|---:|---:|
| semiconductor observations | 594 | 342 |
| distinct symbols | 16 | 15 |
| distinct dates | 41 | 21 |
| eligible-long observations | 205 | 209 |
| harshest tier (ratio >= 2.0, **-22**) | **150** | 148 |
| strongest reward (ratio < 0.7, **+18**) | 26 | 39 |

The base counts differ (the review ran two days earlier against a smaller table, and may
have scoped to rows where P/E was applied), but the two load-bearing numbers agree closely:
**~150 observations sit in the -22 tier** and ~205 are eligible-long. The conclusion is
unchanged and confirmed: a blanket removal would have lifted roughly 150 observations by
22 points each.

Full tier distribution (US, semiconductors):

| tier | ratio | adjustment | rows |
|---|---|---:|---:|
| harshest | >= 2.0 | -22 | 150 |
| | 1.4-2.0 | -12 | 47 |
| | 1.0-1.4 | -3 | 35 |
| | 0.7-1.0 | +8 | 35 |
| best | < 0.7 | +18 | 26 |
| **not applied** | — | 0 | **301** |

**New finding not in the review:** 301 of 594 semiconductor observations (51%) got NO P/E
adjustment at all — `pe_scoring_status <> 'applied'`, i.e. non-positive or beyond
`MAX_SCORABLE_PE = 200`. Half the sector already receives no P/E signal, which weakens the
case that the term is doing meaningful work here and should be measured before any change.

Worked example (AMD, most recent row): `pe_ratio` 123.28 against
`pe_sector_norm` 30 via `pe_sector_mapping_status: "crosswalk"` gives
`pe_vs_sector_ratio` 4.11 -> the -22 tier.

**Also withdrawn: the blanket `CYCLICAL_SECTORS` set.** Revision 1 proposed covering
energy, materials, autos and shipping. None of those were measured. Energy in particular is
a large fraction of the current book, so a change there is high-impact and entirely
unevidenced. Semiconductors are the only sector with a measurement behind them.

### Revised F1 — semiconductor-only, MEASURE-ONLY ablation

No live formula change. Build a frozen, read-only counterfactual that:

1. Replays recorded observations using the **exact additive behaviour above** — for each
   row, recompute `fundamental_score` with the P/E adjustment removed, and propagate
   through the recorded `weights_used` and availability mask.
2. Reports, semiconductors only: score deltas by tier, `entry_eligible` threshold
   crossings in both directions, and same-date rank changes.
3. Reports eligible-long benchmark-neutral h5/h10 outcomes for the affected rows.
4. Is scoped to `semiconductors` alone. Other cyclical sectors are out of scope until
   separately measured.

The underlying intuition — that a single year's earnings misprices a cyclical — remains
sound, and standard valuation practice is to assess cyclical earnings across a full cycle
([Damodaran, *Valuation*, ch. 22](https://pages.stern.nyu.edu/~adamodar/pdfiles/val3ed/c22.pdf)).
But that argues for a **normalised-earnings experiment**, not for deleting P/E. Deleting
the term is not the same intervention as normalising the input, and revision 1 conflated
them. A normalised-earnings arm is the better long-term experiment and is recorded here as
future work, not proposed now.

---

## F2 — macro is constant in VALUE but not in EFFECTIVE WEIGHT

`fetchMacroScore(supabase, market, now)` takes no symbol, and the raw US macro score was
constant within every one of 48 production dates inspected.

**Corrected mechanism.** Revision 1 concluded from this that macro contributes zero
cross-sectional rank information. That is wrong, and the reason is the availability mask.

`computeWeightedAnalystScore` renormalises weights **per row** across whichever dimensions
are available for that row. Rows differ in which dimensions are missing, so the *effective*
macro weight differs between symbols on the same date. A constant value multiplied by a
varying weight is not a constant contribution, so macro **can and does** move
cross-sectional rank.

**Re-verified independently 2026-08-31**, and the effect is WIDER than the review reported:

| check | verified | review |
|---|---|---|
| dates where macro VALUE is constant | **49 of 49** | 48 of 48 |
| dates where macro WEIGHT varies | **46 of 49** | 45 of 48 |
| effective weight range | **0.0% - 42.86%** | 15% - 37.5% |

The review's 15%-37.5% understated it. Actual production distribution of the macro weight:

| weight | rows | share |
|---:|---:|---:|
| 0.150 | 2,153 | 40.4% |
| 0.1667 | 1,500 | 28.1% |
| 0.250 | 1,379 | 25.9% |
| 0.000 | 99 | 1.9% |
| 0.375 | 66 | 1.2% |
| 0.4286 | 33 | 0.6% |

This confirms the review's correction on the live baseline too: the modal US macro weight is
**15%**, not the 10% revision 1 quoted from `archetypes.ts`. Note the 99 rows at weight
**zero** — macro unavailable and excluded — sitting alongside rows at 42.86% on the same
dates. That spread is precisely the mechanism revision 1 missed.

### Exclusion counterfactual — REPRODUCED 2026-08-31

The replay is exact rather than approximate. Recorded `analyst_score` is already
`sum(score_k * effWeight_k)`, so excluding macro and renormalising the remainder is:

```
new_score = (analyst_score - macro_score * w_macro) / (1 - w_macro)
```

using the row's own recorded `weights_used` and `availability_mask`. No weights assumed.

| metric | reproduced | review |
|---|---:|---:|
| rows replayed | 5,156 | 5,143 |
| mean absolute score change | **2.83** | 4.83 |
| maximum change | **12.33** | 35 |
| upward threshold crossings | **35** | 32 |
| downward threshold crossings | **152** | 146 |
| dispersion before | 14.124 | 14.31 |
| dispersion after | 17.120 | 18.91 |

**Crossings and dispersion-before reproduce closely. The magnitude columns do not, and the
reason is methodological.**

118 rows have fewer than 3 available dimensions. Removing macro from those leaves one
dimension, and `computeWeightedAnalystScore` does **not** renormalise in that case — its
`includedDims.length >= 2` guard falls back to the FIXED base split. Those rows cannot be
reconstructed from `effWeights` alone, so the table above excludes them. Applying the
renormalisation formula to them anyway (which production would never do) inflates the
result:

| scope | n | mean abs | max abs | up | down | dispersion |
|---|---:|---:|---:|---:|---:|---|
| modellable (dims >= 3) | 5,156 | 2.83 | 12.33 | 35 | 152 | 14.124 -> 17.120 |
| all rows incl. low-dim | 5,274 | 2.89 | **27.75** | 35 | 163 | 14.296 -> 17.300 |
| low-dim only (dims < 3) | 118 | 5.38 | 27.75 | 0 | 11 | 20.237 -> 23.871 |

The review's `dispersion before` of 14.31 matches the all-rows figure (14.296) rather than
the modellable one (14.124), so it appears to have included the low-dim rows — which
accounts for the larger maximum. **The conservative reading is the correct one**: those 118
rows do not renormalise in production, so their contribution is an artefact of the
counterfactual, not a property of the change.

**The conclusion is unchanged and holds under either method.** Threshold crossings are
strongly asymmetric — **152 down against 35 up**, roughly 4:1 — and dispersion rises about
21%. Excluding macro would make the book materially more selective, not neutrally cleaner.
These are not trade flips (downstream evidence and direction gates still apply), but they
establish that F2 is a live behavioural change, not a mechanical cleanup.

**Also withdrawn: the "US and India must share one objective" argument.** Revision 1 treated
the divergence (India excludes macro entirely) as a defect. It is not inherently one.
Market-local scoring is legitimate; performance is compared through market-specific
benchmark-relative returns. Forcing identical formulas could actively harm India if its
informative dimensions differ. The claim is retracted.

### Revised F2 — two separate experiments, neither enabled

**F2-i — selection-score macro exclusion (measure-only).** Replay using the *recorded*
availability masks and *recorded* `weights_used` — not assumed weights. Report threshold
crossings both directions, same-date rank changes, eligible-long benchmark-neutral h5/h10,
turnover, concentration, and benchmark excess return.

**F2-ii — book-level macro risk simulation (measure-only).** Macro as an exposure/timing
control rather than a selection input, requiring an **explicit regime-to-exposure policy**
declared in advance: caps, stale-data behaviour, and rollback conditions. Moving macro into
sizing is a separate risk-policy approval, not a consequence of approving F2-i.

Neither promotes without clearing predeclared replay **and** forward-shadow gates.

---

## F3 — Dead scoring code (approved in principle, pending owner go-ahead)

`buildStockPrompt` (`lib/research-agent.ts:1052`), `buildEtfPrompt`, and — per the review —
`buildSynthesisPrompt` are unreachable. The live path is `computeScores` and shares none of
their logic.

They contain a complete, plausible-looking scoring specification, including at `:1253` an
instruction to use *"general macro knowledge"* that contradicts the doctrine preamble at
`:1039` forbidding recalled numbers. This is a documentation hazard, and a demonstrated
one: reading it produced a confident wrong claim about macro scoring during the drafting of
revision 1.

### Approved scope, behaviour-neutral

1. Delete `buildStockPrompt`.
2. Delete `buildEtfPrompt`.
3. Evaluate and, if confirmed dead, delete `buildSynthesisPrompt`.
4. Remove the stale comment at `:406` claiming momentum flows through `buildStockPrompt`.
5. Verify no call sites via static search; then full test suite, typecheck, and a
   production-parity build.

No behaviour change by construction. Ship separately from F1/F2.

---

## What this does NOT propose

- No semiconductor domain model (design wins, foundry allocation, HBM contracts,
  book-to-bill, hyperscaler capex). None of that data is fetched by any provider in this
  stack, and the base scorer has no demonstrated cross-sectional edge to improve on
  (US eligible-long h10 rank IC **-0.077** / 21 dates; India **-0.008** / 17 dates).
- No blanket cyclical-sector rule.
- No live formula change of any kind. F1 and F2 are now measurement instruments only.
- No change to eligibility thresholds, sizing, stops, targets, or exits.
- No claim that any of this improves returns.

## Sequencing

1. **F3** — behaviour-neutral cleanup, on owner approval.
2. **F1 ablation** — semiconductor-only, measure-only, exact additive replay.
3. **F2-i** — selection-score exclusion replay on recorded masks and weights.
4. **F2-ii** — book-level risk simulation, only with a separately approved regime-to-exposure
   policy.

Nothing in 2-4 changes live scoring. Promotion of any arm requires predeclared replay and
forward-shadow gates.

## Open items

- ~~Production figures unverified pending Supabase~~ **RESOLVED 2026-08-31.** F1 and F2
  figures re-verified independently against production; both conclusions hold. Base counts
  differ from the review's in F1 (594 vs 342 observations) and the F2 weight range is wider
  than reported (0-42.86% vs 15-37.5%). Neither difference changes a recommendation.
- ~~F2 exclusion counterfactual unreproduced~~ **RESOLVED 2026-08-31.** Reproduced from the
  rows' own recorded weights and masks. Crossings and dispersion-before match the review;
  the magnitude figures are smaller because 118 low-dimension rows that production would not
  renormalise are excluded here. Direction and asymmetry (152 down / 35 up) confirmed under
  both methods.
- Remaining unverified: nothing. All figures in this document are now reproduced against
  production.
- Confirm `buildSynthesisPrompt` is genuinely unreachable before deleting it.
- A normalised-earnings arm for cyclicals is recorded as future work, not proposed.
