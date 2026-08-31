# Codex review brief — sector scoring integrity (2026-08-29)

Adversarial review requested on an architecture proposal, **not** on shipped code.
Nothing here has been implemented. The proposal is
`features/sector-scoring-integrity/FEATURE_ARCHITECTURE.md`.

**Assume every claim below may be wrong.** The author's track record on this codebase in
the last 48 hours includes four claims that did not survive contact with production
(listed at the end). Verify against the repo and the database rather than trusting the
prose.

## What triggered this

The owner asked whether the system is equipped to score hardware/semiconductor stocks
properly. The answer given was no. This brief asks you to check whether that answer, and
the three findings supporting it, are correct — and whether the proposed responses are the
right ones.

## Claim 1 — the live scoring path is deterministic

Asserted chain:

```
lib/research-agent.ts:1711  computeScores()
  -> lib/data/scores.ts:589  scoreFundamentals()
       -> lib/data/scores.ts:103  resolveSectorPeBenchmark()
            -> lib/data/scores.ts:70  SECTOR_PE_NORM
  -> lib/data/scores.ts  fetchMacroScore(supabase, market, now)
-> lib/scoring/weighted-score.ts  computeWeightedAnalystScore()
-> analyst_score -> entry_eligible
```

**Verify:** is `computeScores` the only producer of the recorded `analyst_score` /
`fundamental_score` / `macro_score` on `decision_observations`? Is there a second live
writer (agentic MCP flow, Edge Function, legacy endpoint, backfill script) that produces
these columns by another route? The project rule requires searching for duplicate scorers,
schedulers, Edge Functions and legacy endpoints — please do that search explicitly.

## Claim 2 (F1) — semis are folded into technology and the value rule inverts on cyclicals

- `lib/data/scores.ts:82`: `semiconductors: "technology"` in `FINNHUB_INDUSTRY_TO_SECTOR`.
- `SECTOR_PE_NORM.technology = 30`.
- Asserted consequence: because semiconductor P/E inverts across the cycle (peak earnings
  compress the multiple), a "P/E below sector norm is cheap" rule fires hardest at peak
  cycle, which is backwards for this sector.

**Verify:**
1. Does `scoreFundamentals` actually reward low P/E-vs-norm, and with what weight inside
   the fundamental dimension? Quantify it rather than accepting the qualitative claim.
2. How many production `decision_observations` rows were scored through the
   `semiconductors -> technology` crosswalk? If the answer is near zero, F1 is
   theoretical and should be deprioritised — say so.
3. Is the cyclicality argument sound as stated, or overreaching? It is asserted from
   general reasoning, **not** from a measurement on this book. Push back if it does not
   hold for the specific formula in `scoreFundamentals`.
4. Which sectors in `SECTOR_PE_NORM` would a `CYCLICAL_SECTORS` set need to cover, and
   does marking the P/E term "unavailable" interact correctly with the availability mask
   and `computeWeightedAnalystScore` renormalisation? Look for a case where excluding it
   makes the score worse or triggers the `abstain` path unintentionally.

## Claim 3 (F2) — macro_score is symbol-independent, so it adds no cross-sectional signal

- `fetchMacroScore(supabase, market, now)` takes no symbol argument.
- Macro weight is 0.10 in most archetypes, 0.20 in `etf_trend`, 0.25 in
  `india_sector_rotation` (`lib/scoring/archetypes.ts`).
- India already excludes macro (`available: false`) and renormalises.
- Asserted consequence: on US names, 10-20% of the composite is a constant within any
  single date's cross-section, contributing zero rank information; and US vs India
  composites are therefore different objectives.

**Verify:**
1. Is macro genuinely constant within a US cross-section on a given date? Check
   `decision_observations.macro_score` grouped by `date(ts)` for US — variance should be
   zero if the claim holds. If it varies, the claim is wrong and F2 collapses.
2. Does a constant dimension actually contribute zero to a **Spearman rank IC** of the
   composite? Confirm the algebra rather than accepting it — the composite is a weighted
   sum, so a constant shifts every score equally and should not change ranks, but verify
   there is no interaction via the availability mask making it non-constant in practice
   (e.g. rows where macro is unavailable for some US symbols but not others on the same
   date — that would make it vary, and would be a *different* problem worth reporting).
3. Is F2-a (move macro to a sizing/exposure gate) sound, or does it silently remove a
   real protective behaviour? Join macro-regime cohorts to matured outcomes before calling
   it either way — the project rule forbids calling a condition protective without that.

## Claim 4 (F3) — buildStockPrompt is dead code

- `lib/research-agent.ts:1052` `buildStockPrompt`, plus an ETF sibling, contain a complete
  scoring spec including `:1253` "use ... general macro knowledge".
- Asserted: zero call sites; only a comment reference at line 406.
- Asserted: `:1253` contradicts the doctrine preamble at `:1039` which forbids recalled
  numbers.

**Verify:** confirm they are genuinely unreachable (including dynamic dispatch, string
lookup, re-export, or use from a script/test that runs in production). Check git history
for whether they were ever live and what replaced them. If dead, is deletion safe, or is
something staged to revive them?

## What the proposal deliberately declines to do

It rejects building a semiconductor domain model (design wins, foundry allocation, HBM
contracts, book-to-bill, hyperscaler capex, export controls) on the grounds that:

- none of that data is fetched by any provider currently in the stack, and
- the base scorer has no demonstrated cross-sectional edge to improve on: US eligible-long
  h10 rank IC **-0.077** (21 dates), India **-0.008** (17 dates), both below the 60-date
  review floor and the overlap-adjusted observation floor.

**Please attack this reasoning specifically.** Is "do not add domain sophistication to a
scorer with no measured edge" correct engineering judgement here, or is it an excuse that
leaves a known-bad scorer in place? Argue the other side if you can make it.

## Context you need

- Cohort discipline: `lib/learning/entry-cohort.ts` — every predictive claim must be on
  `entry_eligible = true AND direction = 'long'`. All-scored figures are context only.
  Three published claims were retracted on 2026-08-28 for violating this.
- Evidence floors: `MIN_PREDICTIVE_DATES = 20`, `MIN_EFFECTIVE_OBSERVATIONS = 12`
  (overlap-adjusted, `n / horizonDays`), `MIN_REVIEW_DATES = 60`.
- Frozen-history rule: annotate, never re-decide. Recorded scores and decisions are not
  rewritten; a changed metric gets a new plan/genome version.
- Scoring Data-Truth Review Protocol in `CLAUDE.md`: production distributions, per-market
  proof (US and India separately), enumeration of defaults and their production hit
  fraction, and a frozen read-only counterfactual before any live formula changes.

## The author's recent error record, for calibration

Four claims that failed verification in the last 48 hours, all the same shape — a
confident conclusion drawn from the wrong population or an unread code path:

1. "Rotation has never moved capital" — false; it had executed swaps. Read NULL linkage
   columns and ignored `status='paper_executed'` in the same rows.
2. "India's largest positions lose money" — measured on closed lots only; 8 of 14 open
   positions were in the largest quartile and reversed the sign.
3. "India's score ranks forward returns, +0.105" — that was the all-scored cohort; the
   eligible-entry cohort is -0.008.
4. "macro_score comes from LLM general knowledge" — read from `buildStockPrompt`, which
   is dead code; the live path is deterministic and well-guarded. This error is *inside
   this very analysis* and was caught before the proposal was finalised, which is why F3
   exists.

Treat the prose accordingly. Production and the code are the authorities.

## What a good review returns

- A verdict per claim: confirmed / partially wrong / wrong, with the query or file:line
  that settles it.
- A recommendation on sequencing, including "do none of this yet" if that is right.
- Any duplicate scorer, second writer, or legacy endpoint the author missed.
- If you would architect a different response to the hardware-scoring question, say so
  and describe it.
