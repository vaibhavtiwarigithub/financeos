# Systematic Pattern Discovery — Feature Architecture

> Status: **PARKED — IDEA ONLY. NEEDS MORE RESEARCH AND THOUGHT BEFORE ANY BUILD.**
> Captured: 2026-09-05. Author: Claude (Opus 5), Architect role. Owner: Vaibhav.
> **Do NOT start implementation from this document.** It records a line of thinking and the
> objections against it. Several load-bearing claims below are UNVERIFIED training knowledge
> and are marked as such. Every one must be checked against a primary source before any
> decision rests on it.
> No migration, no code, no data acquisition, no provider signup is authorized here.

## 0. What this is

An automated alpha-research layer: mine long historical price/fundamental data for statistically
significant patterns, validate them cross-sectionally and out-of-sample, and graduate only the
survivors into Kairos's existing shadow framework as non-executing signals.

Triggered by a 2026-09-05 conversation about the overnight-drift anomaly (buying at close and
selling at the next open historically dominating open-to-close returns for some names).

## 1. Why it's interesting

The overnight/intraday return split is a real, peer-reviewed effect, not folklore. Cliff, Cooper &
Gulen (2008) and Lou, Polk & Skouras (2019) document that a large share of the US equity risk
premium has historically accrued overnight (close→open) rather than intraday (open→close).
Plausible mechanisms: earnings and analyst actions releasing outside market hours, options-dealer
hedging flow at the open, institutional order accumulation during the session executing at/after
the close.

⚠️ **UNVERIFIED**: the two citations above are from training knowledge. Confirm authors, years and
actual findings before citing them anywhere that matters.

More important than this one anomaly: Kairos has no systematic way to ask *"which known effects
actually work in our universe?"* That question is answerable and currently unanswered.

## 2. The two objections that nearly kill it

These are the reasons this is parked rather than scheduled. Neither is resolved.

### 2.1 Survivorship bias

The motivating example (one semiconductor name showing an extraordinary cumulative overnight
return) is very likely this bug. That company survived; same-sector peers that went to zero are
absent from every free dataset. Backtesting today's index constituents over 20 years selects on
two decades of survival and makes almost any rule look excellent.

**Consequence:** the data requirement is not "historical prices." It is "historical prices
including securities that died." That is a much shorter and mostly non-free list of sources.

### 2.2 Multiple comparisons

200 features × 4 horizons × 6 cross-sectional slices ≈ 4,800 tests. At p<0.05, roughly 240 will
appear significant by chance alone. Without Benjamini-Hochberg (or equivalent) correction plus a
strict time-based out-of-sample holdout, this system's primary output will be confident noise.

This is the main event, not a footnote. Any build plan that treats correction as a later
refinement is wrong.

## 3. Why `price_cache` cannot be the source

An initial version of this plan proposed building the feature library from the existing
`price_cache` table. That is wrong and was corrected in the same conversation.

`price_cache` holds only symbols Kairos has actually researched, only since Kairos began running.
Direct evidence from the 2026-09-05 exit-geometry counterfactual: joining closed `paper_trades` to
`price_cache` matched only **55 of 113** non-tainted India trades and **40 of 52** US trades — it
does not fully cover even the names we have already traded.

Discovery needs ~15-20 years, thousands of symbols, and multiple regimes (2008, 2020, 2022).
That data must come from outside. This is the single largest open work item.

## 4. Data sources — ALL UNVERIFIED, verify before use

⚠️ Compiled from training knowledge on 2026-09-05 with web search and firecrawl both unavailable.
Treat every row as a hypothesis. Check licence terms, actual history depth, and delisted-symbol
coverage directly before relying on any of them.

| Source | Claimed history | Delisted included? | Cost | Note |
|---|---|---|---|---|
| NSE bhavcopy | Full | Believed yes | Free | Daily archive files. Believed the cleanest free option |
| Stooq | ~20y | Partial | Free | Bulk CSV, global |
| Yahoo (yfinance) | 20y+ | **No** | Free | Survivorship-biased. Usable for features on live names; NOT for backtest truth |
| SEC EDGAR | Full | Yes | Free | Fundamentals/filings incl. bankrupt filers. No prices |
| Kaggle dumps | Varies | Partial | Free | Quality varies; verify before trusting |
| Sharadar (Nasdaq Data Link) | ~20y | Yes | Paid | Likely the technically correct answer |
| Norgate | ~40y | Yes | Paid | Retail gold standard |

**Constraint conflict, unresolved:** the survivorship-complete sources appear to be the paid ones,
which collide with the standing $0-cloud rule (see `[[feedback-free-cloud-only]]`). The two
candidate resolutions — accept and *measure* US survivorship contamination, or treat India as the
clean research market and US as features-only — are open questions for the owner (§8).

## 5. Storage sketch (if it ever proceeds)

~5,000 symbols × 20 years × 252 sessions ≈ **25M rows**. Supabase free tier is ~500MB
(⚠️ unverified current figure). Raw prices must not live in Supabase.

```
Cloudflare R2 (10GB free tier — unverified)   ← raw OHLCV as Parquet, partitioned by year
        ↓
GitHub Actions (2000 min/mo free — unverified) ← DuckDB over Parquet: features + IC
        ↓
Supabase                                       ← results ONLY: feature IC, pattern registry, hypotheses
```

Consistent with the free-cloud rule if the tier figures hold. Verify all three before committing.

## 6. The cross-sectional grid — the actual product

A pattern must survive every slice. This grid, not a list of patterns, is what would make this
worth building.

| Slice | Question | What it kills |
|---|---|---|
| Per stock | Holds for one name? | Nothing — single-stock findings are always noise |
| Pooled cross-section | Holds for the median of thousands? | Stock-specific flukes |
| By sector | Tech only, or utilities too? | A sector factor disguised as a signal |
| By geo | US and India both? | US-microstructure artifacts |
| By regime | 2008 + 2020 + 2022 + calm? | "Long beta in a bull market" |
| By liquidity tier | Large and small cap? | Illiquidity premium in disguise |
| By era | 2005-12 / 2013-20 / 2021-now? | Decayed, already-arbitraged effects |

Overnight drift is the natural first test case: if it appears in US large cap AND India AND across
2008/2020/2022 AND in both tech and utilities, it is structural. If it only appears in US semis
post-2015, it is a story about one company, not a strategy.

## 7. Role of the LLM — deliberately narrow

The LLM is **not** the alpha source. Treating it as one is the fastest route to a confident wrong
answer. Its legitimate jobs:

1. **Hypothesis generation** — propose feature combinations worth testing. Cheap, parallel, fine if
   most are junk.
2. **Mechanism check** — for a surviving pattern, argue why it *should* persist. A pattern with no
   economic mechanism is a coincidence with good p-values.
3. **Kill-condition authoring** — name what would break it (spreads widen, regime flips, crowding).

Statistics decide; the LLM proposes and narrates. If it is allowed to validate, this becomes an
expensive confirmation-bias machine.

## 8. Open questions — must be answered before any build

1. **Survivorship**: accept measured contamination in a free US dataset, or make India the research
   market (clean, free) and treat US as features-only? Unresolved, owner decision.
2. Do the free tier figures in §5 actually hold today (R2 10GB, GH Actions 2000 min, Supabase 500MB)?
3. Does NSE bhavcopy genuinely include delisted names for the full window, and what is its licence?
4. What is the minimum viable feature count that is worth the multiple-comparison cost? Fewer, better
   motivated features may beat 200 scattergun ones.
5. Does this compete for attention with the *already-identified* problems (exit geometry, US
   selection having no rank, the just-repaired learner)? Those are known defects with known impact;
   this is speculative upside. Sequencing matters and currently favours the known defects.
6. What is the realistic maintenance cost of a 25M-row pipeline on free infrastructure?

## 9. Honest expected outcome

Finding a genuinely novel, undiscovered anomaly is unlikely — this ground has been mined by better-
resourced quants for forty years. The realistic value, in descending order:

1. **Which known anomalies actually work in Kairos's universe.** Momentum may be alive in the India
   names and dead in the US ones. Currently unknown; directly actionable.
2. **Regime conditioning** — e.g. "momentum works below VIX 20, inverts above 30." Upgrades existing
   dimensions rather than adding new ones.
3. **A kill list** — proof that a dimension currently being scored has zero IC. Given the Alpha
   Diagnostic already reported US selection "has no rank," this may be the highest-value output.
   Deleting a dead dimension is a real improvement.

That is a good outcome. It is not "find a secret nobody knows," and the feature should never be
justified on that basis.

## 10. Proposed sequencing (only if approved later)

- **Phase 0 — prove the pipe.** NSE bhavcopy, 2 years, → R2 Parquet, DuckDB, one question:
  does overnight drift exist cross-sectionally in India? Stop cheaply if the pipe or the answer fails.
- **Phase 1** — history + storage; measure and *document* US survivorship contamination.
- **Phase 2** — feature + IC engine, BH correction on by default.
- **Phase 3** — time-based OOS gate (pre-2022 discover / post-2022 validate). Expect most Phase 2
  findings to die here.
- **Phase 4** — survivors get an LLM mechanism hypothesis and enter the **existing** shadow
  framework. No new promotion path — champion/challenger already exists.

## 11. Related

- `[[feedback-free-cloud-only]]` — the $0 constraint this collides with
- `features/shadow-population/FEATURE_ARCHITECTURE.md` — the graduation path any survivor would use
- `features/alpha-diagnostic-lab/FEATURE_ARCHITECTURE.md` — already diagnosed "US selection has no rank"
- `docs/arch/09-learning-loop.md` — champion/challenger machinery this would feed
