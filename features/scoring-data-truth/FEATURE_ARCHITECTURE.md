# Scoring Data-Truth Audit

**Status:** Corrective fixes implemented; semantic redesigns remain proposed
**Date:** 2026-07-31
**Markets:** US and India, always evaluated separately
**Money path:** Yes. Research scores can authorize paper and future live entries.

## 1. Problem

The scorer's formulas were individually plausible, but provider payloads did not
always satisfy the formula's assumed contract. Static review and synthetic tests
therefore passed while production data produced systematically distorted scores.
The critical example was treating Finnhub `finnhubIndustry` as a GICS sector and
silently applying a P/E norm of 20 whenever its value did not match a GICS key.

Finnhub documents Profile 2 as returning its own `finnhubIndustry` classification;
the free response does not provide the paid profile's GICS `gsector` field:
https://www.finnhub.io/docs/api/crypto-profile

## 2. Production Findings Reproduced

Snapshot queried on 2026-07-31.

| Finding | Production result |
|---|---:|
| Finnhub fundamental rows, last 7d | 425 |
| Rows silently using unmatched/default P/E 20 | 291 (68%) |
| Finnhub P/E median / p90 / max | 30.56 / 153.84 / 8,827.05 |
| Finnhub P/E > 200 | 31 / 425 |
| US technical score exactly 20, last 45d | 320 / 1,635 (19.6%) |
| India technical score exactly 20 | 55 / 405 (13.6%) |
| US technical score exactly 100 | 315 / 1,635 (19.3%) |
| India technical score exactly 100 | 163 / 405 (40.2%) |
| Usable dimensions, last 7d US | technical 687; sentiment 664; macro 687; insider 288 |
| Usable dimensions, last 7d India | fundamental 200; technical 200; sentiment/macro/insider 0 |

Availability is read from `decision_observations.features.weighting.included_dims`,
not from non-null score columns. Score columns retain neutral placeholders even when
a dimension is excluded.

India sentiment is wired, but GDELT supplied zero usable observations in the measured
window. The defect is availability, not missing source code. Core learner, validation,
champion, and performance records are market-scoped; the unresolved issue is score
comparability, not direct US/India pooling on the money path.

## 3. Corrective Build

### 3.1 Fundamental taxonomy and P/E

- Provider mappers stamp `SectorTaxonomy`.
- Known Finnhub industries use an explicit, reviewable industry-to-sector crosswalk.
- Ambiguous or unknown industries do not receive a fabricated sector norm.
- P/E values outside `(0, 200]` are unpriceable for this component. They are omitted,
  not winsorized and not assigned a maximum bearish penalty.
- Other valid fundamental fields continue scoring when P/E is omitted.
- Evidence records expose mapping and omission status.

`MAX_SCORABLE_PE=200` is a data-sanity bound, not an alpha threshold. The valuation
ladder already saturates long before 200, so larger values add no ranking information
and are commonly caused by near-zero trailing earnings.

### 3.2 Breakdown veto

Only either of these can hard-veto:

1. A down move of at least 2.5 ATR.
2. A decline of at least 7% on at least 1.5x average volume.

A bottom-quartile close on an ordinary down day remains evidence as a warning but no
longer independently forces technical score 20. Matured labels did not support that
condition as a hard classifier: US h2 was positive on average with a 61.8% win rate,
and India h5 was positive with an 80% win rate in the available small cohort.

### 3.3 Availability and one scorer

- Fundamental, sentiment, macro, and insider inclusion require explicit
  `dataQuality.*Available === true`; missing fields fail closed.
- A macro row with missing/out-of-range `danger_score` is unavailable.
- `available=true` insider evidence without a finite 0..100 score is unavailable.
- The Supabase `research-agent` Edge Function is retired with HTTP 410.
  `/api/agents/research/cron` plus `lib/research-agent.ts` is the sole scorer.
- The US scanner fallback is market-scoped. Deep Dive reads same-market signals and
  holdings and never attaches the US macro regime to India.

## 4. Counterfactual Impact

A read-only SQL reconstruction over 21 days applied the new P/E mapping, P/E omission,
and technical-veto rule to frozen observations and their recorded effective weights.

| Market | n | Old pass | Estimated new pass | Up flips | Down flips | Old avg | Est. new avg |
|---|---:|---:|---:|---:|---:|---:|---:|
| US | 1,461 | 640 | 741 | 106 | 5 | 56.97 | 58.49 |
| India | 368 | 274 | 284 | 17 | 7 | 73.62 | 75.49 |

This is diagnostic only. It infers historical provider taxonomy where old evidence did
not stamp it and does not replace a point-in-time replay. Historical signals, positions,
and trades are never rewritten. New behavior begins with future research.

## 5. Still Proposed, Not Implemented

These change strategy semantics and require owner approval plus shadow evidence:

1. **Insider redesign.** Shadow `current` versus `exclude-insider` and a purchase-only
   event feature. Do not invent a new baseline from the same small sample.
2. **Per-market threshold calibration.** The mandate already stores separate thresholds.
   Calibrate precision, return, pass rate, and turnover per market; do not force numeric
   score equivalence across different available dimensions.
3. **True PEAD.** Add point-in-time actual-versus-consensus earnings surprise and drift
   as a shadow archetype. Options-implied move remains risk, not surprise direction.
4. **India exit policy.** Diagnose time-stop concentration against MFE/MAE and fresh
   score paths before changing hold periods or exit thresholds.
5. **Technical ceiling.** Scores at 100 are saturated (US 19.3%, India 40.2%). Evaluate
   a versioned shadow formula; do not tune the live formula from this audit.

## 6. Acceptance Invariants

- No unknown provider taxonomy silently receives a valuation benchmark.
- No invalid P/E can become confident bearish evidence.
- A weak close alone cannot hard-veto.
- Missing availability metadata excludes a dimension.
- Exactly one production component can write authoritative ResearchAgent scores.
- No corrective deployment writes an order or mutates historical trades.
