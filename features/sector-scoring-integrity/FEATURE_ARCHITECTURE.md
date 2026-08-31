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

Measured production reach (from the independent review; not independently re-verified here
because the Supabase MCP connection is down — flagged as a dependency, see Open items):

- 342 semiconductor observations, 15 symbols, 21 dates
- 209 eligible-long observations
- **148** observations landed in the harshest tier (-22)
- **39** received the strongest reward (+18)

So a blanket removal would have lifted 148 observations by 22 points each.

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
macro weight differs between symbols on the same date — observed between **15% and 37.5%**,
varying within 45 of the 48 dates inspected. A constant value multiplied by a varying weight
is not a constant contribution, so macro **can and does** move cross-sectional rank.

Preliminary exclusion counterfactual over 5,143 rows (independent review):

| metric | value |
|---|---:|
| mean absolute score change | 4.83 points |
| maximum change | 35 points |
| upward threshold crossings | 32 |
| downward threshold crossings | 146 |
| score dispersion | 14.31 -> 18.91 |

These are not trade flips — downstream evidence and direction gates still apply — but they
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

- The production figures in F1 and F2 come from the independent review and have **not**
  been re-verified here: the Supabase MCP connection is currently failing
  (`CONNECT_TIMEOUT`). Re-verify before acting on them.
- Confirm `buildSynthesisPrompt` is genuinely unreachable before deleting it.
- A normalised-earnings arm for cyclicals is recorded as future work, not proposed.
