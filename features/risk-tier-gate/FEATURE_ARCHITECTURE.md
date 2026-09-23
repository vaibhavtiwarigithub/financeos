# Risk-Tier Gate — Feature Architecture

> Status: **Stage 1 LIVE (measure-only shadow)**. No gate, no sizing, no order-path change.
> Author: Claude (Sonnet 5), 2026-09-18. Approved by Vaibhav 2026-09-18 (item #4 of the
> `achaljhawar/1rok` gap-analysis plan — see PROJECT_DECISIONS.md).
> Source of the idea: `github.com/achaljhawar/1rok`'s Risk Agent, whose prompt discloses an
> exact deterministic-looking scoring shape (base 30, component maxes, tier/investability
> thresholds) even though their implementation is LLM-judged. This document adapts that
> *disclosed shape* into a 100% deterministic Kairos component — no LLM, no new provider.

## 1. What this is, and isn't

**Is:** a 5-component additive risk composite (`lib/risk/risk-tier.ts`, `computeRiskTier`) computed
from data ResearchAgent already fetches every run — AV `COMPANY_OVERVIEW` (beta, debt/equity, profit
margin, gross margin), `lib/data/technicals.ts` (ATR-multiple of the last bar's move, the existing
breakdown veto), `macro_regime.danger_score` (US-only, same availability gate as `macro_score`), and
days-to-next-earnings (already computed for the earnings blackout). Written to
`decision_observations.features.risk_tier_shadow` on every scored candidate.

**Isn't:** a gate. It reads nothing that isn't already fetched, writes nothing that anything else
reads, and blocks no signal, no sizing, no order. `analyst_score`, direction, sizing, and every
existing gate are byte-for-byte unchanged.

## 2. Why measure-only first

Same discipline as every other new signal in this codebase (instrument-family evidence, oil
exposure, the technical calibration shadow): a new composite must accumulate real evidence and prove
its predictive value before it is trusted to block or shrink a real position. This one has an
additional reason to wait: an honest asymmetry in how it's built (§4) that a gate cannot tolerate but
a shadow can.

## 3. The five components

| Component | Max | Inputs | Availability |
|---|---|---|---|
| Volatility | 30 | `beta` (AV overview), `atrMultipleMove` (last bar's move in ATR units) | Excluded (null) when both missing |
| Fragility | 30 | `debt_to_equity`, `profit_margin`, `gross_margin` | Excluded when all three missing |
| Concentration | 20 | none — no segment/customer/geography data source exists in this codebase | A diversified fund (`broad_equity_etf`/`sector_etf`/`thematic_etf`/`fixed_income_etf`/`india_etf`) gets a real near-zero value (2); a single name is honestly UNAVAILABLE, not guessed |
| Macro | 15 | `macro_regime.danger_score`, US-only | Same gate as `macro_score`: excluded for India, stale rows, or an `unknown` verdict |
| Special | 20 | `daysToEarnings <= 5`, active technical `breakdown_veto`, short-interest squeeze setup (`short_percent_float > 20%` + `short_ratio_days`, added 2026-09-18 — see §5) | Excluded only when none of the three signals are present (each defaults to "no evidence of elevated event risk", not neutral) |

`totalRisk = clamp(30 + sum(available components), 0, 100)`. Tiers: LOW ≤30, MODERATE ≤50, HIGH ≤70,
VERY_HIGH >70 (1rok's own disclosed thresholds). Investability label (not yet consumed anywhere):
`full` <50, `medium` 50-69, `small` 70-85, `not_investable` >85.

## 4. The asymmetry, stated not hidden

This is an **additive penalty** system, not a renormalized weighted average like `analyst_score`. A
missing component contributes **zero** risk points — not a neutral default. That means a symbol with
thin data reads *lower* risk than one with full data showing the identical real risk. This is the
**opposite** bias from `analyst_score`'s "abstain when evidence is thin" convention, and it is the
reason this ships as a shadow: `coverage` (0-5, how many components were available) travels with every
row specifically so a future consumer — or a human reviewing the Research Journal — can tell "low
risk" from "low evidence" apart. **A future promotion to a real gate must either fix this asymmetry
(e.g., require a coverage floor, or make missing-evidence itself count as risk) or explicitly accept
it with eyes open — this document does not resolve that, it flags it.**

## 5. What was deliberately not built (yet)

- **Short interest — added 2026-09-18.** Yahoo's `defaultKeyStatistics` module (`shortPercentOfFloat`,
  `shortRatio`) was already being fetched for every US symbol (`fetchIndiaOverview` in
  `lib/india-data.ts`, called by `fetchUsOverview`'s Finnhub-gap-fill pass) but never parsed. Added a
  `BONUS_COPY_ONLY` list in `lib/data/fundamentals.ts` so these two fields ride along **only** when
  Yahoo is already being called for some other gap — deliberately NOT added to the `FILLABLE`
  gap-trigger list, because Finnhub can never supply them, which would have forced an extra Yahoo call
  on every single US symbol (including ones with full Finnhub coverage) as a silent side effect. Real
  coverage is therefore partial, not universal, by design — same honest-unavailable convention as
  everything else here.
- **Options-derived risk** (IV percentile, put/call ratio) — a real input 1rok's risk agent uses that
  Kairos has no free data source wired for today. Still a fast-follow, not in this pass.
- **Institutional ownership trend** — a different signal from the existing Form 4 insider score;
  separate future item.
- Any consumption of `investability` or `tier` by sizing, entry, or the order path — that is the
  eventual point of building this, but it is a separate, evidence-gated promotion decision, exactly
  like every other measure-only signal here (instrument-family scoreMode, oil exposure, technical
  calibration).

## 6. Acceptance criteria

1. Zero change to `analyst_score`, direction, sizing, entry/exit gates, or any order path.
2. No new provider call — every input is already fetched by the existing ResearchAgent run.
3. Fail-soft: a thrown error in `computeRiskTier` or its inputs must never block the decision it's
   attached to (wrapped in its own try/catch, same as `instrumentFamilyEvidence`/`oilExposureEvidence`).
4. `coverage` is always present alongside `totalRisk` so a low score can never be read as "verified
   low risk" without checking how much evidence it rests on.
