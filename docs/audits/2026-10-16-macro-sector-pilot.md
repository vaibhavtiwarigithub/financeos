# Macro-to-sector historical pilot — 2026-10-16

## Verdict

The available history is enough to begin descriptive macro/sector research, but
the first production-data pilot is **not point-in-time-clean or promotion-grade**.
It does not justify changing any score, weight, position size, entry, or exit rule.
The useful finding is about data readiness: Kairos has real long-history macro
archives locally, but its production sector-price overlap is only about two years,
and the stored India macro rows do not preserve the original release/availability
timestamps needed to certify historical as-known inputs.

## Data inventory

The local governed evidence store already contains more history than the live
database view suggested:

| Dataset | Verified local coverage | Important limit |
|---|---|---|
| FRED/ALFRED macro vintages (`fred-alfred-macro-vintages-2026-07-29-v5`) | 1991-01-01 through 2026-07-29; 54/54 source files; 11 series | Only series with an actual vintage/availability clock may enter a point-in-time replay. The intake record marks several latest-only series non-PIT and refuses them. |
| NSE daily bhavcopy (`nse-bhavcopy-2020-01-01-2026-07-29-v6`) | 2020-01-01 through 2026-07-29; 1,625/1,716 expected weekday files; ~2.98m EQ bars | 91 weekdays remain unreconciled; corporate actions include unsupported/ambiguous cases; current company-sector tags are not historical classifications. |
| NSE corporate actions | 79 monthly files, 2020-2026 | 222 ambiguous/unsupported price-affecting actions prevent broad adjusted-return claims. |
| Production benchmark closes | US VOO/QQQ/XLF/XLK and India NIFTY/BANKBEES/ITBEES/JUNIORBEES, roughly 2024-08/09 through 2026-10 | Close-only; ETF distributions are not included, so these are not total returns. |
| Official Nifty Indices historical reports | The page offers historical index data and a separate Total Returns Index (TRI) series, including sectoral categories; a one-year Nifty IT TRI request returned dated observations | NSE's research-data list includes historical index data in its first basket, but that category can be free or at-cost; it is not a blanket license. The website separately prohibits systematic or automated data collection without express written consent. Do not automate or bulk-download it without written permission and a use/license review. The one-year endpoint cap also makes any approved acquisition a bounded, versioned process. |
| Production India macro observations | NIFTY, India VIX, USD/INR, Brent and other series mostly from 2024-10 through 2026-10 | Historical Yahoo/FRED observations were fetched in Oct 2026; `fetched_at` is not the original publication timestamp. They cannot be certified as-known on each historical date. |
| Production weekly US `macro_regime` | 17 snapshots from 2026-06-29 through 2026-10-12 | Too few independent episodes for a US regime-conditioned return conclusion. |
| App score ledger | `decision_observations` begins 2026-07-06 | Historical prices do not recreate the actual app score before that date. |

The local acquisition record and fingerprints are in
`features/historical-evidence-intake/ACQUISITION_RECORD.md`. Raw evidence remains
outside the repository and was not copied or uploaded by this pilot.

## Exploratory India proxy check

I ran a read-only aggregate over production `india_macro_observations`,
`benchmark_price_observations`, and `benchmarks`:

- Universe: ITBEES, BANKBEES, JUNIORBEES versus the NIFTY 50 index.
- Window: overlapping history after a 20-session factor lookback, approximately
  Nov 2024-Sep 2026 depending on factor availability.
- Inputs: India VIX level (`>20` vs. not), 20-session USD/INR change, 20-session
  Brent change, and 20-session NIFTY change.
- Labels: close-to-close 5/10/20-session sector-proxy return less NIFTY return.
- Sampling: only every 5th, 10th, or 20th aligned NIFTY session for the matching
  horizon, avoiding direct overlap among label windows. These are still not
  independent macro episodes; serial dependence and ETF close-only basis remain.
- This was exploratory, not preregistered. No significance or forecast claim is
  made.

Illustrative 5-session results (mean benchmark-relative price return):

| Fixed state split | BANKBEES | ITBEES | JUNIORBEES | Non-overlapping outcome windows per state (not independent episodes) |
|---|---:|---:|---:|---|
| VIX > 20 | +0.406% | -0.292% | -0.479% | 4 high-state windows; 80 not-high |
| Brent up over prior 20 sessions | +0.081% vs +0.293% when not rising | -0.509% vs -0.411% | +0.120% vs +0.104% | 38-46 per state, depending on sector/date coverage |
| USD/INR up over prior 20 sessions | +0.107% vs +0.332% when not rising | -0.261% vs -0.919% | +0.108% vs +0.123% | 26 not-rising / 58 rising windows |

At 20 sessions, the VIX > 20 arm contains **one** non-overlapping window. These
counts are not independent macro episodes: nearby state windows may belong to
the same long-running episode. The other state splits have only about 8-11
windows per arm. Effects vary by sector
and horizon; these examples do not establish an edge. The close-only return
contract also omits ETF distributions, so even these numbers are exploratory
price-relative comparisons, not investor total-return results.

The exact query is available in the conversation/tool history; the frozen
production data was not exported into this repository. A production-grade
replay should instead bind local files to a manifest and persist its query/code
fingerprint before evaluating results.

## What this does and does not answer

- **Does macro context vary by industry?** The directional differences above are
  plausible hypotheses, but this sample does not identify a reliable effect.
- **Does it improve Kairos stock selection?** Not tested. The ETF proxies do not
  represent stock-specific responses, and historical Kairos scores do not exist
  before July 2026.
- **Can the old data be used?** Yes. The local ALFRED vintage archive supports a
  US as-known macro feature set back to 1991. NSE supplies a substantial India
  price panel from 2020. They still need a matching, validated sector/benchmark
  return dataset and appropriate universe/action treatment.
- **Can we fit regimes to the full sample then report the best one?** No. State
  thresholds, scaling, and any analog-selection rule must be fixed in training
  only, then evaluated in later walk-forward periods. Searching many state
  definitions and reporting the winner would overfit.

## Next safe data and research steps

1. Keep the US ALFRED macro vintages, using only `replay_eligible` series and
   their vintage/release clock. Never substitute a latest-revised series into
   an old decision date.
2. Acquire/freeze adjusted or total-return histories for a small, fixed set of
   US sector proxies and the broad-market benchmark. Label nonofficial/free
   source history as diagnostic unless provenance and redistribution terms are
   verified.
3. For India, first obtain written NSE Indices permission or an appropriate
   licensed dataset before any systematic TRI collection. The historical
   reports page exposes TRI values and a one-year request returned Nifty IT
   observations, but the site terms prohibit automated data collection without
   express written consent. NSE lists historical index data in its first-basket
   research data, but that basket may be free or costed and does not override
   the site terms. Do not automate this endpoint until permission/licensing is
   clear. See https://www.niftyindices.com/reports,
   https://www.niftyindices.com/resources/index-concepts/total-return-index,
   https://www.niftyindices.com/terms-of-use, and the NSE data-list PDF at
   https://nsearchives.nseindia.com/web/sites/default/files/inline-files/Data%20list%20under%20NSE%20Data%20Sharing%20Policy%20for%20Research%20and%20Analysis_20250728.pdf.
   Do not apply today's sector tags to 2020 constituents and call it historical.
4. Predeclare a small feature set and horizons (5/10/20 sessions), fit any
   scaler/matcher within training folds, purge overlapping labels, and compare
   each sector's conditional distribution with the unconditional and benchmark
   baselines. Report distinct macro episodes, effective windows, intervals,
   source coverage, and costs.
5. Only after the local diagnostic is reproducible should a prospective,
   market-local, append-only shadow collect forward predictions. Keep it
   measure-only and do not call it a trading upgrade until paired OOS portfolio
   evidence exists.

No score, weight, trade, broker, risk, or live setting was changed. No migration,
cron, API, or recurring shadow was added.
