# Sector scoring integrity — cyclicals, constant dimensions, and dead scoring code

> Status: **DRAFT — architecture proposal, awaiting owner approval. No code written.**
> Date: 2026-08-29. Influence if approved: money path (`analyst_score` → direction gate → paper buys).

Triggered by the question "are we equipped to score hardware/chip stocks properly?"
Answer: **no**, and the reasons generalise well beyond semis. Three findings below, each
traced to the live path. A final section states what this deliberately does NOT propose.

## The live scoring path (established, not assumed)

```
research-agent.ts:1711  computeScores()            <- "Compute all 5 scores deterministically"
  |- lib/data/scores.ts:589  scoreFundamentals()
  |    |- :103  resolveSectorPeBenchmark()
  |         |- :70  SECTOR_PE_NORM
  |- fetchMacroScore(supabase, market, now)        <- NOTE: no symbol parameter
  |- scoreTechnicals / scoreSentiment / normalizeInsiderScore
-> lib/scoring/weighted-score.ts  computeWeightedAnalystScore()
-> analyst_score -> entry_eligible -> proposals
```

Scoring is **deterministic**, not LLM-generated. This matters: an earlier reading of this
system claimed macro came from LLM "general macro knowledge". That was wrong, and F3
explains why the code invites exactly that error.

---

## F1 — Semiconductors do not exist as a category, and the value rule inverts on cyclicals

`lib/data/scores.ts:82` maps `semiconductors -> technology`, and `technology` carries a
single P/E norm of **30** (`SECTOR_PE_NORM`, line 70).

Consequences on the live path:

- A memory maker, a fabless designer, a fab-equipment vendor and a server assembler are
  all benchmarked against one multiple. These have structurally different margin
  profiles, capital intensity, and customer concentration.
- Semiconductor P/E **inverts across the cycle**: earnings peak late, compressing the
  multiple; earnings trough early, inflating it. A rule rewarding "P/E below sector norm"
  therefore scores cyclicals most generously at peak earnings — the textbook cyclical
  value trap. This is not a coarse approximation; on this sector it is directionally
  wrong.

`resolveSectorPeBenchmark` already returns `mappingStatus` of
`direct | crosswalk | missing | unmapped`, so the plumbing to treat a sector specially
exists.

### Options

**F1-a — Split the sector and re-norm (small).** Give `semiconductors` its own
`SECTOR_PE_NORM` entry instead of folding it into technology.
*Cost:* one map entry. *Risk:* a single number invented without evidence; it changes
recorded scores, so it needs a plan-version bump wherever those are compared.

**F1-b — Mark cyclicals ineligible for the P/E-cheapness component (recommended).**
Introduce `CYCLICAL_SECTORS` (semiconductors, energy, materials, autos, shipping). For
these the P/E term is reported **unavailable**, and the existing availability mask
renormalises the remaining fundamental inputs — the same mechanism already used for
missing data.
*Why preferred:* it removes a signal we can show is inverted rather than inventing a
replacement we cannot yet validate. It fails toward "we don't know", which is the posture
the rest of this system already takes.

**F1-c — Build a semiconductor domain model (rejected for now).** Design wins, foundry
allocation, HBM contracts, book-to-bill, hyperscaler capex, export-control exposure.
*Rejected because:* none of it is fetched by any provider in this stack today, and the
base scorer has no demonstrated cross-sectional edge to improve on (US eligible-long h10
rank IC **-0.077** / 21 dates; India **-0.008** / 17 dates; both below floor). Adding a
domain module now means more surface area with no instrument able to tell us whether it
helped. Revisit when A2 clears its evidence floor.

---

## F2 — `macro_score` carries weight but no cross-sectional information

`fetchMacroScore(supabase, market, now)` takes **no symbol**. It reads MacroSentinel's
weekly `macro_regime` verdict: a single market-wide number.

The scorer is careful and correct about macro's *own* integrity — a 10-day staleness
bound, a >=3-indicator floor, fail-closed to unavailable, and an explicit refusal to stamp
the US regime onto India (scored `available: false` and excluded).

But the composite it feeds is consumed **cross-sectionally**. Every A2 and dimension-IC
statistic ranks symbols against each other on a single date. A dimension identical for
every US symbol that week contributes exactly **zero** rank information while consuming
its weight:

| archetype | macro weight |
|---|---:|
| quality_momentum, value_inflection, pre_earnings, india_quality_momentum | 0.10 |
| etf_trend | 0.20 |
| india_sector_rotation | 0.25 |

So on US names 10% of the composite (20% for `etf_trend`) is a constant. It cannot change
any ranking; it can only compress the spread contributed by the four dimensions that do
vary. On India macro is already excluded and renormalised — so **the India and US
composites are not the same objective**, which matters for any cross-market comparison.

### Options

**F2-a — Exclude macro from the cross-sectional composite; keep it as a gate (recommended).**
Macro is a real signal — it is a *timing/exposure* signal, not a *selection* signal. Route
it to position sizing or a book-level risk gate, where a market-wide number is exactly the
right shape, and renormalise the selection composite onto the four symbol-varying
dimensions.
*Effect:* US composites stop carrying a constant and become structurally comparable to
India's. This changes `analyst_score`, so it is a money-path change requiring its own
approval and a genome/plan version bump.

**F2-b — Leave it, document it.** Cheapest. The dilution is bounded and now known.
*Argument for:* with no demonstrated edge anywhere, reshuffling weights is unfalsifiable
right now.

**F2-c — Make macro symbol-varying.** Per-sector rate and geopolitical sensitivity (a chip
name is far more export-control exposed than a utility). This is the version that would
genuinely help hardware scoring — and it is a real build with no current data source. Not
proposed now; recorded as the honest long answer to F1-c.

---

## F3 — Dead scoring code documenting a rule the system does not use

`buildStockPrompt` (`lib/research-agent.ts:1052`) and its ETF sibling contain a full
scoring specification: `fundamental_score: based on P/E vs sector...`,
`macro_score: sector tailwinds, interest rate sensitivity, geopolitical exposure`, and at
`:1253` an instruction to use *"general macro knowledge"*.

**These functions have zero call sites.** The only reference is a comment at line 406. The
live path is `computeScores`, which shares none of this logic.

The `:1253` instruction also contradicts §1 of the doctrine preamble in the same file
(`:1039`): *"Every number that drives a decision MUST trace to a tool call made in THIS
run... If you find yourself recalling a number, stop — that is hallucination."*

This is not a runtime bug — dead code cannot hallucinate. It is a **documentation hazard**,
and a demonstrated one: reading it produced a confident, wrong claim about how macro
scoring works, within the same hour this document was written. Anyone auditing the scorer
meets these ~200 lines before reaching `lib/data/scores.ts`.

### Options

**F3-a — Delete (recommended).** Remove `buildStockPrompt` / `buildEtfPrompt` and their
prompt constants. Zero behaviour change by construction.

**F3-b — Keep, annotate loudly.** If they are a staged agentic path someone intends to
revive, mark them `@deprecated NOT THE LIVE SCORING PATH` and resolve the `:1253` / `:1039`
contradiction before any revival.

Check git history first — it should say whether these were ever live.

---

## What this does NOT propose

- No semiconductor or hardware domain model (see F1-c).
- No new provider, data source, or dependency.
- No change to eligibility thresholds, sizing, stops, targets, or exits.
- No claim that any of these will improve returns. F1 and F2 remove signals that are
  demonstrably uninformative or inverted; that is a correctness argument, not a
  performance one, and should be judged as such.

## Sequencing

1. **F3** first — zero behaviour change, removes the trap that misleads every later reader
   of this subsystem.
2. **F2** decision — F2-a is the substantive one and needs owner approval; F2-b is a
   legitimate hold given no measured edge.
3. **F1-b** — needs a recorded-score plan-version bump and a frozen counterfactual showing
   how many historical `entry_eligible` flips it causes.

## Evidence obligations before F1 or F2 ships

Per `CLAUDE.md` Scoring Data-Truth Review Protocol:

- Production distribution of `fundamental_score` for cyclical vs non-cyclical sectors, US
  and India separately.
- Count of live rows where `resolveSectorPeBenchmark` returned `crosswalk` through the
  `semiconductors -> technology` hop.
- Exact `entry_eligible` flip count under a frozen, read-only counterfactual.
- Confirmation that no historical decision is rewritten (annotate, never re-decide).
