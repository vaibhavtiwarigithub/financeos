# Earnings Expectations & Peer Delta — Feature Architecture

> Status: **DRAFT — architecture only. Awaiting Vaibhav's approval before any Builder work.**
> Author: Claude (Sonnet 5), Architect role. 2026-09-03.
> Scope: design only. No migration, provider activation, scoring change, candidate emission,
> shadow-decision write, or order-path change is authorized by this document.
> Update this file when: source contracts, PIT capture rules, peer methodology, η definition,
> combination-testing methodology, or Upgrade Paths integration change.
> Companion: `docs/audits/2026-09-03-earnings-expectations-peer-delta-codex-brief.md` (adversarial
> review brief — every load-bearing claim below is re-derivable from that brief's SQL and sources).

---

## 0. Verdict up front

**RESHAPE, then GO for a narrow Stage 0/1, with two hard gates before anything wider.**

The core idea — that forward-looking, peer-relative estimate revisions carry information a
current-fundamentals/price-momentum scorer cannot see — is real and has primary-source support
(Hameed, Morck, Shen & Yeung 2010, §5). But the prompt's scope, taken as written, is too large for
what the data and the provider budget can support today. Three things must shrink or defer, and one
operational risk (Alpha Vantage's shared call budget) must be resolved before Stage 1 commits to a
symbol count:

1. **No management-guidance extraction in Stage 1.** It is the single most complex, LLM-adjacent,
   look-ahead-prone part of the prompt, and nothing downstream needs it to get a first η measurement.
   Own-company and peer estimate REVISIONS (not guidance) are sufficient to test the core hypothesis.
   Guidance extraction becomes a **Stage 2+** decision, gated on Stage 1 clearing its own bar.
2. **No new lifecycle taxonomy.** The prompt proposes
   `unavailable → collecting → measurable → shadowing → eligible → rejected/retired`. Kairos already
   has one shared `ShadowLifecycle` enum (`lib/shadows/registry.ts:1-9`) used by all 21 registered
   Upgrade Path programs: `collecting | ready_for_review | blocked | armed | paper_active | idle |
   off | not_applicable`. This feature reuses that enum at the top level and puts the requested finer
   granularity in a nested `stage` field — exactly the pattern `technical-calibration` already uses
   (`edge_readiness_status.stage` nested inside a `collecting`/`ready_for_review` lifecycle). Two
   lifecycle vocabularies on one Upgrade Paths page is the redundant-system the brief itself warns
   against.
3. **India is fully deferred**, not merely de-prioritized. No India source contract has been
   verified (§4.5); this document proposes no India work beyond a not-yet-run capability probe.
4. **Alpha Vantage's call budget is shared and its true production ceiling is unverified.**
   Production consumed 35–71 AV calls/day over the last 10 days (measured, §4.4) while the code's own
   default budget constant (`lib/data/provider-fetch.ts:29`) is 25/day — meaning either a paid tier is
   active that isn't visible in this session's `.env.local`, or the gate is already being exceeded.
   **This is the single largest feasibility risk in the whole feature and is not resolved here.**
   Stage 0 must confirm the actual contracted plan before Stage 1 commits to any symbol count.

With those four changes, Stage 0 and Stage 1 are buildable now, cheaply, and Stage 1's evidence
(§9.2) will tell us honestly whether Stage 2 (peer baskets) is worth building at all.

---

## 1. Verified current-state audit

Every number below was re-derived against the production database
(`dionkikgdmlaotvtbnfr`) or read from the live source file on 2026-09-03. See the companion Codex
brief §2 for the exact SQL.

### 1.1 What exists today

| Claim in the originating prompt | Verified | Detail |
|---|---|---|
| `lib/data/earnings-pit.ts` captures upcoming US consensus vintages + first-observed actuals | **TRUE** | 303 lines. Append-only; never overwrites `eps_actual_first`; later differing prints go to `restated_eps`. Deterministic, no LLM. |
| Capture covers only a small default US watchlist | **TRUE** | Called from the existing earnings-refresh cadence on whatever symbol set that cron passes — not the full universe. |
| Production: 56 consensus snapshots, 19 symbol/report-date events, 9 symbols, 0 basis-comparable actual-vs-consensus events | **TRUE, exact match** | `select count(*) from earnings_consensus_snapshots where market='us'` → 56. `count(distinct symbol‖report_date)` → 19. `count(distinct symbol)` → 9. |
| `decision_observations`: 5,911 US rows, 4,125 with analyst-recommendation evidence | **TRUE, exact match** | `features->'analyst'` is present on exactly 4,125/5,911 US rows. |
| Analyst *targets* in only 157 US decision observations | **TRUE, exact match, wrong field path in the prompt** | The prompt implied a top-level `analyst_target` key; the real path is `features->'fundamental'->>'analyst_target'` (157/5,911). Source is Alpha Vantage `OVERVIEW.AnalystTargetPrice`, a **current snapshot with no horizon, no PIT vintage, and `analyst_target_mode: "observational_only"`** (`lib/data/scores.ts:240-248`) — it is not comparable to a pre-announcement consensus and was never claimed to be. |
| `scoreAnalyst()` is measure-only, not in the live composite | **TRUE, and the variable-naming trap that would mislead a future auditor is real** | `research-agent.ts:1502-1510`'s own comment: captured as "LOGGED EVIDENCE … NOT fed into the live weighted score yet." But `analystScore` (no space) elsewhere in the same file (`research-agent.ts:1711-1714`) is the **entire 5-dimension weighted composite** from `computeWeightedAnalystScore`, an unrelated meaning. A reader grepping for `analystScore` and finding it gates trade eligibility (`research-agent.ts:1938`) could wrongly conclude the Finnhub recommendation dimension is live. It is not. |
| Live fundamental scorer uses P/E (sector-relative), margin, ROE, EPS, YoY revenue growth; no guidance/revision dimension | **TRUE** | `lib/data/scores.ts:121-221`. |
| Earnings dates affect risk/repricing but not scoring inputs | **TRUE, three distinct mechanisms, correctly separated already** | (a) `lib/risk/earnings-repricing.ts` — a **freshness barrier**: suppresses a stale technical score until the post-event daily bar exists; not alpha, explicitly documented as such. (b) `lib/risk/earnings-risk.ts` — a separate risk-monitor path using a same-strike option-move proxy. (c) `days_to_earnings` is logged as an **observed feature only** (`research-agent.ts:1544`, "not a gate or sizing input"), present on 4,117/5,911 rows. |
| `symbol_profiles.peers`: 97/187 US profiles, 534 relationships, 0/51 India | **TRUE, exact match** | `sum(array_length(peers,1))` over US = 534. India peers array is always `[]` by explicit design (`lib/data/symbol-profile.ts:178`: "no free India peers source"). |
| `/api/peer-moves` is display-only, same-session peer price moves, never scored | **TRUE** | Module-level comment states it explicitly; verified no import of `lib/data/peer-moves.ts` outside its own route and test. |
| `guidance_cut`/`guidance_raised` exist in the vocabulary, zero production events | **TRUE** | `lib/events/vocabulary.ts:73-86`. Not verified by count in this pass (no `market_events` rows queried), but the module's own comment states the family was "Added 2026-08-05 by owner review" and no capture pipeline references it anywhere in `app/`. |
| The relationship graph failed its coverage study and must not be revived | **TRUE, and the failure mode is instructive** | `features/relationship-graph/P0_COVERAGE_STUDY.md`: 5/79 US filers (6.3%) yielded a named, weighted, tradable customer link; **structural**, not a parsing gap — US GAAP (ASC 280-10-50-42) requires the *amount* of a ≥10% customer, not the *name*, and issuers anonymize hardest on the highest-exposure links (Digital Realty names Oracle at 9.0% while anonymizing its #1 tenant at 11.7%). Recommendation on record: "do not build P1–P5 … revisit only if the covered universe reaches ~500+ US issuers." |

### 1.2 New findings this review made (not in the originating prompt)

1. **Finnhub's own documentation states its earnings-calendar EPS/revenue are non-GAAP** —
   verified verbatim from `https://finnhub.io/docs/api/earnings-calendar`: *"EPS and Revenue in this
   endpoint are non-GAAP, which means they are adjusted to exclude some one-time or unusual items."*
   This is unconditional, not row-specific, so it **can safely resolve the prospective basis contract**
   (§4.2) — but only prospectively; the 56 existing rows with `eps_basis = null` are not retroactively
   reinterpreted (frozen-history rule).
2. **Finnhub's free earnings calendar caps historical depth at one month**: *"Free Tier: 1 month of
   historical earnings and new updates."* This explains why 51 days of production history (2026-07-08
   to date) yields only 9 symbols and 19 events — it is not an early-feature artifact, it is a hard
   provider ceiling. `earnings-pit.ts` cannot backfill a longer PIT history from Finnhub at any price
   on the free tier; only forward accumulation from first capture is possible, which the module's own
   comment already states.
3. **Finnhub's `/stock/eps-estimate` endpoint is `Premium: Premium Access Required`**, and even its
   documented free-tier-adjacent shape is thinner than Alpha Vantage's free endpoint — no revision
   history, no 7/30/60/90-day deltas, just current avg/high/low/analyst-count. This settles decision
   §12.2 below.
4. **Alpha Vantage's `EARNINGS_ESTIMATES` is live and free with Kairos's own configured key** —
   verified with two real, read-only GET calls against `ALPHA_VANTAGE_API_KEY` (IBM and EXEL, a
   mid-cap Kairos holding, not just a mega-cap). Both returned real data, not a premium-lock message.
   Fields: `eps_estimate_average/high/low`, `eps_estimate_analyst_count`,
   `eps_estimate_average_{7,30,60,90}_days_ago`, `eps_estimate_revision_{up,down}_trailing_{7,30}_days`,
   and the revenue equivalents — for both `fiscal year` and `fiscal quarter` horizons in one call. This
   is the multi-horizon, revision-history, analyst-count source the prompt hypothesized, confirmed real.
5. **Alpha Vantage's overall daily call budget is shared and its true ceiling is unverified.**
   `lib/data/provider-fetch.ts:29` defaults `AV_DAILY_BUDGET` to 25/day; the checked-in
   `.env.local` does not override it; production consumed 35, 71, 60, 36, 8, 45, 67, 56, 67, 47 calls
   across the last 10 days (`provider_budget` table) — already over the local default on 7 of 10 days.
   Either Vercel's production env sets a higher budget than this session can see, or the gate is
   already being routinely exceeded. **This must be confirmed before any symbol count is committed.**
6. **Finnhub `/stock/peers` supports a `grouping` parameter** (`sector | industry | subIndustry`,
   default `subIndustry`) that `lib/data/symbol-profile.ts` does not currently pass — it is already
   using the narrowest, most defensible grouping by default, which is a stronger starting point for
   peer candidates than the architecture originally assumed.
7. **`signal_score_history` has no `analyst_target` or `analyst_upside_pct` column**, though
   `research-agent.ts:2213-2214` inserts both on every research run (`error: scoreHistErr` is captured
   but the surrounding code path was not traced far enough to confirm whether the whole insert fails or
   only those keys are silently rejected by PostgREST). **This is a pre-existing defect, out of scope
   for this architecture, and is flagged to Codex in the companion brief** rather than fixed here —
   fixing it would be implementation, and this document is architecture only.

---

## 2. Problem and user value

Kairos's live composite scorer sees: current fundamentals (P/E, margin, ROE, EPS, revenue growth —
all trailing/TTM), current technicals, current sentiment, current macro regime, current insider
activity. It has **no forward-looking axis** — nothing that answers "is the market's opinion of this
company's *future* improving or deteriorating, and how does that compare to its peers?"

That is a genuinely different information set from momentum (which is backward-looking price) and
from current fundamentals (which are backward-looking accounting). Hameed, Morck, Shen & Yeung (2010,
NBER w15833) found that stocks with thin analyst coverage co-move with the price moves of
heavily-covered peers in the same industry, asymmetrically — well-covered names lead, thinly-covered
names follow, not the reverse. That is direct empirical support for exactly the peer-relative,
asymmetric-influence design this feature proposes (§7).

**User value, concretely:** a bounded, auditable signal — "this company's forward estimates are
improving *faster than its peers'*" — tested honestly against the existing eligible-long cohort, on
the same walk-forward/purged/cost-adjusted discipline every other dimension in this codebase is held
to, with no shortcut to "it correlates with returns" as a stopping point (acceptance criterion #19).

---

## 3. Explicit non-goals

This feature does **not**, at any stage without a separate governed decision:

- Change scoring, eligibility, sizing, stops, targets, exits, or orders.
- Claim or model supplier/customer/partner economic relationships (that is the killed relationship
  graph's domain; see §1.1's last row — this feature works with **comparable-company peers**, a
  different and already-provider-covered data type, never economic linkage).
- Extract management guidance from any source in Stage 0 or Stage 1.
- Activate any India data path.
- Compare a symbol against the whole market as its "peer" population.
- Treat `symbol_profiles.peers` as a verified, versioned peer basket — it may only seed candidates.
- Let an LLM generate combinations and pick the backtest winner (§8).
- Invent a second lifecycle taxonomy for Upgrade Paths.

---

## 4. Source-capability findings

### 4.1 Alpha Vantage `EARNINGS_ESTIMATES` — verified live, recommended primary source

```
GET https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol={SYMBOL}&apikey={KEY}
```

Confirmed with the project's real key against `IBM` and `EXEL` (2026-09-03, two read-only GET
requests, no state changed). Response: one `estimates[]` array per symbol, mixing `"fiscal year"` and
`"fiscal quarter"` horizon rows, each carrying:

- `eps_estimate_average/high/low`, `eps_estimate_analyst_count`
- `eps_estimate_average_{7,30,60,90}_days_ago` — a **built-in revision trail**, no need to
  reconstruct 7/30/60-day deltas from our own snapshot cadence
- `eps_estimate_revision_up_trailing_{7,30}_days` / `..._down_trailing_{7,30}_days` — **revision
  breadth**, i.e. contributor-level information without needing contributor-level data
- `revenue_estimate_average/high/low`, `revenue_estimate_analyst_count`

No documented `entitlement` gate or "premium" label on this endpoint (unlike
`TIME_SERIES_INTRADAY`, which the same doc page marks `Trending Premium`). No basis field — Alpha
Vantage does not state GAAP vs. non-GAAP for this endpoint anywhere found in this pass; **treat as
unknown basis** until a further probe resolves it, same discipline as Finnhub before its docs were
checked.

**Does not cover:** Q+2 explicitly as a distinct labeled row (only "fiscal quarter", which appears to
be the *next* quarter — needs confirmation with a second real quarter's data before Stage 1 assumes a
Q+2 row exists), and does not return a `snapshot_at`/`available_at` — Kairos must stamp its own
capture timestamp as the point-in-time marker, exactly as `earnings-pit.ts` already does for Finnhub
consensus.

### 4.2 Finnhub earnings calendar — confirmed non-GAAP, already wired for actuals

Verified verbatim from Finnhub's own documentation page: *"EPS and Revenue in this endpoint are
non-GAAP, which means they are adjusted to exclude some one-time or unusual items … Estimates are
sourced from both sell-side and buy-side analysts."* Also confirmed: **"Free Tier: 1 month of
historical earnings and new updates"** — a hard depth ceiling, not a coverage gap to fix.

**Decision (see §12.3): this resolves the prospective basis contract.** New Finnhub-sourced captures
from the date this is approved forward may set `eps_basis = 'non_gaap'` deterministically, since the
statement is unconditional across the endpoint, not row-specific. **The existing 56 rows with
`eps_basis = null` are NOT retroactively reinterpreted** — they were captured under real uncertainty
and stay that way; only new rows benefit. This is a plan-version-style change: a new capture-policy
version starts, the old one's rows keep their original (unknown) basis forever.

### 4.3 Finnhub `/stock/eps-estimate` — confirmed premium, ruled out

Explicitly labeled `Premium: Premium Access Required` on Finnhub's own page. Even ignoring the paywall,
its documented shape (`epsAvg/High/Low`, `numberAnalysts`, `period`, no revision fields) is thinner
than Alpha Vantage's free endpoint. **Not recommended as a source at any tier.**

### 4.4 Alpha Vantage call budget — UNRESOLVED, the top operational risk

`lib/data/provider-fetch.ts:29` sets the code-level default at 25 calls/day. Production's own
`provider_budget` table shows **35, 71, 60, 36, 8, 45, 67, 56, 67, 47** calls/day over the ten days
ending 2026-09-03 — exceeding the code default on 7 of 10 days. This means one of:

(a) Vercel's production environment has `AV_DAILY_BUDGET` set to a value this session's
`.env.local` doesn't reflect (a paid AV tier), or
(b) the budget gate (`providerCachedFetch`) is soft/advisory and is already being routinely exceeded
against a real 25/day ceiling, which would mean AV calls are already at risk of being rate-limited or
rejected by the provider.

**This document does not resolve which.** It is Decision §12.7's dependency: no Stage 1 symbol count
should be committed until the actual contracted Alpha Vantage plan is confirmed (ask Vaibhav, or check
Vercel's env directly with appropriate access). A weekly-cadence capture across even 60 symbols is 60
calls the first week and thereafter proportional to how often estimates actually move — cheap against
a paid multi-hundred/day plan, impossible against a real 25/day free ceiling shared with every
existing AV consumer (fundamentals scoring, sector P/E lookups, symbol profiles' India overview reuse).

### 4.5 India — no verified source contract, correctly out of scope

No India-specific probe was run in this pass (explicitly deferred, matching the prompt's own
instruction not to assume US/India parity). `symbol_profiles.peers` is `[]` for all 51 India profiles
by design (no free peers source found previously). Alpha Vantage's international coverage for NSE/BSE
tickers, if any, is unverified — India symbols in this codebase use a Yahoo-style `.NS`/`.BO` suffix
convention that does not obviously match Alpha Vantage's symbol format. **A separate Stage 0b India
probe is required before any India activation; this document proposes none.**

### 4.6 Management guidance sources — surveyed, not selected for Stage 0/1

- **SEC EDGAR full-text search + 8-K EX-99.1 press releases**: has real point-in-time timestamps
  (`acceptanceDateTime`, confirmed reliable by the relationship-graph P0 probe: "Works. … intraday-
  precise"), free, and is the only source with genuine PIT guarantees. But guidance figures inside a
  press release are unstructured prose — extraction needs either a deterministic regex/table parser
  (fragile across issuers) or an LLM (needs the full §10 boundary). **Not built in Stage 0/1.**
- **Investor presentations / earnings call transcripts**: even less structured, no reliable
  free source with PIT timestamps at Kairos's current scale. Ruled out for now.
- **Recommendation for whenever guidance extraction is revisited**: start with a
  **deterministic-first parser** against the small set of issuers that publish a structured
  guidance table in their EX-99.1 (a real, testable subset — not assumed universal), and reserve the
  LLM path for the residual only after the deterministic parser's own coverage is measured, per the
  user's own instruction to evaluate deterministic-first before defaulting to an LLM.

---

## 5. Pressure test — steelman then attack

**Steelman.** The value case is not "another momentum proxy." Estimate revisions are opinion-updates
by third parties who often have private-ish information advantages (buy-side/sell-side channel
checks), and the Hameed et al. finding gives a real, citable mechanism (information diffusion lag
across thinly- vs. widely-covered peers) rather than a data-mined correlation. The existing scorer
structurally cannot see this axis — it has no forward-looking dimension at all.

**Attack, and how the design answers each:**

- *Does this duplicate price momentum?* Partially, unavoidably — estimate revisions correlate with
  recent price action because analysts react to news too. The architecture requires a
  `technicalCorrelation` diagnostic (§9, mirroring `measureSectorSignal`'s own honest-prior check
  against `technical`) reported alongside every η measurement, exactly as `sector-regime.ts` already
  does for its own candidate dimension — "A high correlation here means this is technical in slow
  motion, which is a reason to stop rather than a detail" (verbatim precedent from the existing code).
- *Is coverage sufficient to avoid selection bias?* At 157/5,911 (2.7%) for the *existing* AV target
  field, and unverified for the new `EARNINGS_ESTIMATES` endpoint until Stage 0 measures it across
  Kairos's real universe — this is an open question Stage 0 exists to answer, not assumed away. If
  coverage skews toward mega-caps with heavy analyst followings, the shadow's cohort will silently
  exclude exactly the thinly-covered names the Hameed et al. mechanism is about — the architecture
  requires reporting coverage **by market-cap tier** (already available via `symbol_profiles.market_cap_tier`)
  so this bias is visible, not assumed absent.
- *Is comparing to "all companies" invalid?* Yes, unconditionally — no peer aggregate in this design
  may include the whole market; see §7.
- *Are peer relationships symmetric?* No — Hameed et al. is direct evidence they are not; see §7.2.
- *Does this duplicate the killed relationship graph?* No, if the boundary in §3 holds: peers here
  are Finnhub sub-industry comparables (a provider-classified taxonomy, already free and covering
  97/187 US names), not disclosed economic relationships (which failed on structural SEC disclosure
  sparsity, a different failure mode entirely). The discipline that must be inherited, though: the
  graph's P0 probe measured real coverage on the real universe *before* building anything — this
  architecture's Stage 0 does the same for both the estimates source and the peer-basket source.
- *Does guidance extraction need an LLM?* Possibly, eventually, but not for Stage 0/1's core
  hypothesis test — deferred per §3.
- *Cost/entitlement/freshness feasible on free-cloud-only?* Estimates: yes, confirmed live and free
  (§4.1), pending the budget question in §4.4. Guidance: deferred, so moot for now.
- *Should India be deferred?* Yes, unconditionally, per §4.5 and the prompt's own instruction.

---

## 6. Required conceptual separation

Implemented as **distinct, separately-typed evidence records**, never collapsed into one score:

| # | Concept | Table (see §11) | Never conflated with |
|---|---|---|---|
| 1 | Analyst consensus | `earnings_expectation_snapshots` (kind=`consensus`) | Management guidance |
| 2 | Management guidance | `management_guidance_observations` | Analyst consensus |
| 3 | Realized results | existing `earnings_calendar.eps_actual_first` (reused, not duplicated) | Consensus, guidance |
| 4 | Market-implied expectation | **out of scope** — no options-derived expectation is proposed in this document; noted as a possible future axis only | Everything above |
| 5 | Peer expectations | `earnings_expectation_snapshots` rows for peer symbols, aggregated via η (§7) | Own-company expectations |
| 6 | Price reaction | `reaction_residual` derived measurement (§7.3), computed against `price_cache`/benchmark series already in use elsewhere | Expectation deltas themselves |
| 7 | Economic relationships | **explicitly not modeled** — the killed relationship-graph's domain | Peer comparables (§3, §7) |

---

## 7. Peer methodology and η

### 7.1 Candidate sourcing, not accepted membership

`symbol_profiles.peers` (Finnhub `/stock/peers`, default `grouping=subIndustry`, already free and
already fetched for 97/187 US names) **seeds** a candidate list. It is never read directly as the
accepted peer basket by any measurement code — acceptance requires a versioned, reviewable row in
`peer_group_versions`/`peer_group_members` (§11.3) with an `effective_from` timestamp, so that
acceptance criterion #8 ("peer membership used at time T is the version available at T") is
mechanically enforceable, not a convention.

Basket size: **5–15 companies**, matching the user's own bound. If Finnhub's candidate list returns
fewer than 5 after ETF/instrument-family filtering (see acceptance criterion #11), the symbol is
`peer_basket_unavailable`, not padded with weaker matches.

### 7.2 Asymmetric weighting — leader/follower, not a flat average

Hameed et al. (2010) found the co-movement is one-directional: thinly-covered names follow
heavily-covered ones, not the reverse. This architecture's peer weight is therefore a function of
**relative analyst coverage** (`eps_estimate_analyst_count`, already returned by the Alpha Vantage
endpoint — no new data source needed) between the subject symbol and each peer, not a flat 1/N. A
peer with materially more analyst coverage than the subject gets a higher weight in the subject's η;
a peer with materially less gets a lower one. The exact weighting function (e.g. rank-based vs.
count-ratio) is a Stage 2 design decision, not committed here — Stage 2 must show the weighting
choice does not itself manufacture the effect (a leave-one-peer-influence check, per the required
robustness list).

**Report order** (which peer reports first) and **historically measured lag** are listed in the
prompt as candidate weighting inputs; both require a longer observation history than Stage 1's data
will have. Deferred to a Stage 2+ refinement once base η has enough history to measure lag honestly.

### 7.3 η and companion measurements

```
eta(symbol, horizon) = standardized_own_estimate_revision(symbol, horizon)
                      − weighted_median_peer_revision(peer_basket(symbol), horizon)
```

- **Weighted median**, not mean, per the user's own instruction — robust to one peer's outlier
  revision dominating a small (5–15 member) basket.
- `standardized_own_estimate_revision`: the `eps_estimate_average` change over the relevant window
  (7/30/60/90-day trail, all provided directly by Alpha Vantage — §4.1), standardized within the
  symbol's own history so the units are comparable across names with very different EPS scales.
- **A regression-residual construction is explicitly deferred**, not chosen initially — the bounded
  predeclared-family discipline (§8) argues for starting with the simplest defensible construction
  and only adding a second construction as its own separately-tested hypothesis, never as a
  same-family variant selected post-hoc.

Companion measurements, exactly as specified in the originating prompt, computed only where the
underlying inputs exist (§4 — guidance-dependent ones are inert until Stage 2+ guidance capture
exists, but their formulas are frozen here so they are not redesigned ad hoc later):

- `guidance_gap = guidance_midpoint / pre_release_consensus − 1` — **inert in Stage 1** (no guidance
  capture yet); formula frozen for when Stage 2+ guidance lands.
- `peer_revision_diffusion` = weighted fraction of valid peers whose own revision is positive —
  computable in Stage 1 from estimates alone.
- `reaction_residual = symbol_post_event_return − matched_peer_basket_return` — computable once a
  basket exists; reuses existing benchmark-series/price-cache infrastructure (`getBenchmarkSeries`,
  already used elsewhere in `research-agent.ts`), not a new price-fetch path.
- `peer_lead_signal` — requires the lag-measurement work in §7.2; **Stage 2+**, not Stage 1.

### 7.4 What a peer criterion explicitly is NOT

A peer is a Finnhub sub-industry comparable with an owner-reviewed, versioned, effective-dated
acceptance record. It is never: a disclosed supplier/customer, a "similar-sounding" LLM-generated
guess, an unreviewed raw Finnhub list read live at scoring time, or a basket that changes composition
without a new version row.

---

## 8. Combination discovery — bounded, predeclared

No LLM may generate candidate interactions or select a winning backtest. The predeclared family for
Stage 3 is drawn **only** from the user's own listed hypotheses, and only the subset whose inputs
exist after Stage 1 (own/peer estimate revisions) — guidance-dependent hypotheses (`guidance_gap ×
price above EMA20`, `guidance_cut × breakdown veto`, etc.) are **frozen as formulas, not scheduled**,
until Stage 2+ guidance capture exists:

**Testable from Stage 1 data alone:**
- upward η × positive technical trend
- current-quarter beat × falling Q+1/Q+2 expectations
- current-quarter miss × raised future guidance *(needs guidance — frozen)*
- inexpensive peer-relative valuation × improving forward revisions
- positive expectations × acceptable volatility
- negative expectation shock × existing exit/horizon-extension conditions

That is **five** testable interactions initially — well inside "small predeclared family." Every one
of the mandatory methodology items the user listed (frozen formula/version identifiers, PIT
construction, market/horizon-local folds, purging/embargo per horizon, baseline-vs-baseline-plus-
feature on the identical eligible cohort, multiple-testing/FDR control, incremental IC, after-cost
turnover, sector/size/vintage/regime robustness, peer-membership sensitivity, leave-one-symbol and
leave-one-sector influence, a prospective forward shadow, no automatic promotion) is required and
**none of it is invented fresh** — it reuses infrastructure that already exists and was verified live
in this session's earlier work:

- Purged folds + horizon-matched step spacing: `lib/edges/folds.ts` (already enforces
  `stepSessions >= horizonSessions` and refuses the overlap that `edge-readiness.ts`'s old
  `INDEPENDENT_WINDOW_DAYS = 5` bug allowed — this feature's independence rule must use the SAME
  horizon-aware spacing Codex's 2026-09-03 fix now applies, not a third bespoke rule).
- Rank IC / Spearman with the existing floors: `MIN_PREDICTIVE_DATES = 20`,
  `MIN_EFFECTIVE_OBSERVATIONS = 12`, `MIN_CROSS_SECTION = 5` (used across the codebase's other
  dimension diagnostics — reused verbatim, not reinvented).
- Šidák/multiple-testing correction and Deflated Sharpe / PBO machinery already used by the
  Alpha Diagnostic Lab and the OOS orchestrator (`lib/edges/oos-experiment.ts`'s
  `multipleTesting.method: "trial_adjusted_t_margin"`).
- Cost: `MODELED_SLIP_FRACTION` (`lib/analytics/performance-metrics.ts`, fixed 2026-09-02) for
  after-cost turnover, so this feature's cost accounting matches the paper book and the replay
  exactly rather than inventing a fourth cost constant.

---

## 9. Upgrade Paths contract

**One new `ShadowProgramDefinition` entry**, id `earnings-expectations-peer-delta`, reusing the
existing `ShadowLifecycle` enum at the top level (§0.2). Reports separately for US and India (India
will read `not_applicable` until §4.5's probe exists and is approved).

```ts
{
  id: "earnings-expectations-peer-delta",
  name: "Earnings expectations & peer delta",
  category: "Scoring",
  markets: ["us", "india"],   // india reports not_applicable until its own Stage 0 probe
  ...
}
```

Nested `stage` detail (matching the `edge_readiness_status` precedent, not a new top-level enum):

- `unavailable | collecting | measurable | shadowing | eligible_for_review | rejected | retired`

Reported fields, per market:

- collection coverage (symbols with a captured snapshot / total in-universe), freshness, latest
  successful run
- independent earnings dates covered, basis-comparable event count (mirrors the existing
  `/api/calendar/earnings/coverage` report's own methodology — reused, not reinvented)
- Q+1 / Q+2 / FY+1 horizon coverage (FY+1 confirmed available from AV; Q+2's presence unconfirmed
  per §4.1, must be measured before claimed)
- peer-basket coverage (% of in-universe symbols with an accepted ≥5-member basket)
- h1/h5/h20 incremental rank IC with an HAC t-stat/uncertainty interval (reusing `neweyWestLag` from
  `lib/edges/folds.ts`)
- benchmark- and peer-relative expectancy, average winner, average loser, payoff ratio, profit
  factor — **not win percentage as the headline**, per the explicit instruction; hit rate is a
  secondary field only
- turnover and modeled cost (from `MODELED_SLIP_FRACTION`), max drawdown
- sector/size/regime stability, contribution above current dimensions (technical-correlation
  diagnostic from §5, reported prominently, not buried)
- weeks of prospective shadow stability, blockers, next evidence needed

Refreshes from the producer's **latest completed market-session evidence** on the existing one-minute
page-refresh loop already used by every other Upgrade Path program (`UpgradePathPage.tsx`) — no new
refresh cadence, and a cron invocation is never itself presented as proof the producer generated
fresh evidence (matching the exact defect class Codex's 2026-09-03 review found and fixed in the
Router readiness check).

---

## 10. LLM boundary

**Not exercised in Stage 0 or Stage 1** — no LLM call is proposed until guidance extraction (Stage
2+) is separately approved. When it is:

- LLM output is a **candidate observation only**, never a direct write to a scored/decision table.
- Must quote/anchor the exact source passage and document (SEC filing accession number + exact
  paragraph), matching the mutation/replay requirement.
- Deterministic validation (metric/period/units/range/timestamp) runs on every candidate before
  acceptance; ambiguous values enter a review/quarantine state, never a silent default.
- Extraction confidence is recorded but is never trading confidence, and never overrides a
  deterministically-computed score/direction/size/stop/target/exit/order.
- No missing value becomes a neutral zero — matches every other dimension's `available: false`
  convention already used throughout `lib/data/scores.ts`, `lib/data/analyst.ts`, etc.
- Prompt, model, schema version, and extraction version are recorded per observation.
- A deterministic-first parser is evaluated against the structured subset of issuers before any LLM
  path is built, per §4.6.

---

## 11. Data model

Reuses `lib/edges/*` (folds, PIT universe, OOS runner), the Canonical Evidence Router's provenance
conventions, and the existing `earnings_calendar` table for realized actuals — **no duplicate
provenance, outcome, experiment, or promotion system is created.**

### 11.1 `earnings_expectation_snapshots` (new — replaces the ad-hoc consensus-only
`earnings_consensus_snapshots` for THIS feature's purposes; the existing table is left untouched and
still serves `earnings-pit.ts`'s PEAD-precursor use case unchanged)

```sql
create table public.earnings_expectation_snapshots (
  id                uuid primary key default gen_random_uuid(),
  symbol            text not null,
  market            text not null default 'us' check (market in ('us','india')),
  kind              text not null check (kind in ('consensus')),  -- extend only by owner review
  metric            text not null check (metric in ('eps','revenue')),
  fiscal_period     text not null,          -- e.g. '2026Q4', '2026FY'
  horizon_label     text not null check (horizon_label in ('fiscal_quarter','fiscal_year')),
  value_avg         numeric,
  value_high        numeric,
  value_low         numeric,
  analyst_count     integer,
  revision_up_7d    integer,
  revision_down_7d  integer,
  revision_up_30d   integer,
  revision_down_30d integer,
  value_7d_ago      numeric,
  value_30d_ago     numeric,
  value_60d_ago     numeric,
  value_90d_ago     numeric,
  basis             text,                  -- 'unknown' until a source contract proves it; AV: unknown per §4.1
  currency          text not null default 'USD',
  source            text not null,          -- 'alpha_vantage'
  source_call_id    text,                   -- correlates to provider_call_ledger, for replay
  captured_at       timestamptz not null default now(),  -- our own PIT stamp; AV returns none
  unique (symbol, market, metric, fiscal_period, horizon_label, source, captured_at)
);
```

Idempotency key: `(symbol, market, metric, fiscal_period, horizon_label, source, captured_at)` —
append-only, one row per capture event, never updated. A later capture with an unchanged value is
still a new row (unlike `earnings-pit.ts`'s dedupe-on-unchanged behavior) because the revision-count
fields (`revision_up_7d` etc.) are themselves informative even when the average estimate hasn't moved
— dropping "unchanged" snapshots here would lose that signal.

### 11.2 `management_guidance_observations` (schema frozen now, producer not built until Stage 2+)

```sql
create table public.management_guidance_observations (
  id                  uuid primary key default gen_random_uuid(),
  symbol              text not null,
  market              text not null default 'us' check (market in ('us','india')),
  metric              text not null check (metric in ('eps','revenue')),
  fiscal_period       text not null,
  guidance_low        numeric,
  guidance_high       numeric,
  guidance_midpoint   numeric generated always as (
                        case when guidance_low is not null and guidance_high is not null
                        then (guidance_low + guidance_high) / 2 end
                      ) stored,
  is_withdrawal       boolean not null default false,  -- distinct from a numeric cut — acceptance #3
  basis               text,
  currency            text not null default 'USD',
  source_document_id  text not null,        -- SEC accession number or equivalent
  source_quote        text not null,        -- the exact anchored passage, mandatory for LLM-derived rows
  extraction_method   text not null check (extraction_method in ('deterministic','llm')),
  extraction_version  text,
  llm_model           text,
  llm_prompt_hash     text,
  occurred_at         timestamptz not null,  -- when made public
  available_at        timestamptz not null,  -- when Kairos could first know it
  review_state        text not null default 'pending' check (review_state in ('pending','accepted','quarantined')),
  unique (symbol, market, metric, fiscal_period, source_document_id)
);
```

A withdrawal is `is_withdrawal = true` with `guidance_low`/`guidance_high` both null — never encoded
as a numeric cut (acceptance criterion #3).

### 11.3 `peer_group_versions` / `peer_group_members`

```sql
create table public.peer_group_versions (
  id             uuid primary key default gen_random_uuid(),
  subject_symbol text not null,
  market         text not null default 'us' check (market in ('us','india')),
  effective_from timestamptz not null,
  effective_to   timestamptz,             -- null = current
  candidate_source text not null,          -- 'finnhub_peers_subindustry'
  review_state   text not null default 'pending' check (review_state in ('pending','accepted','rejected')),
  reviewed_by    text,
  reviewed_at    timestamptz,
  unique (subject_symbol, market, effective_from)
);

create table public.peer_group_members (
  version_id  uuid not null references public.peer_group_versions(id),
  peer_symbol text not null,
  weight      numeric,                    -- null until §7.2's weighting function is approved
  primary key (version_id, peer_symbol)
);
```

Enforces acceptance criteria #8 (membership at T = version available at T) and #9 (a peer reporting
after the target cannot leak into the target's earlier decision — enforced by every consumer
filtering `peer_group_versions.effective_from <= decision_ts` and requiring each peer's OWN
`earnings_expectation_snapshots.captured_at <= decision_ts`, not merely the basket's effective date).

### 11.4 Derived feature table

Reuses `edge_signals` (already the home for cross-sectional candidate dimensions like
`rel_strength_6m`, `high_52w_proximity` — see `lib/research/relative-strength-discovery.ts`) rather
than a new table. New `edge_id` values: `earnings_eta`, `peer_revision_diffusion`,
`reaction_residual` (Stage 1+); `guidance_gap`, `peer_lead_signal` (Stage 2+, inert until guidance
exists).

### 11.5 Shadow-run summaries

Reuses the existing `edge_ic_history` / `edge_readiness_status` shape (§9) rather than a parallel
experiment/outcome system — Stage 3's shadow runs write to the same tables `technical-calibration`
already writes to, tagged by `edge_id`.

### 11.6 RLS posture

Every new table: RLS on, `deny anon`, `authenticated` may `SELECT` only, all writes via
`service_role` — the exact pattern `earnings_consensus_snapshots`'s own migration already
establishes (`supabase/migrations/20260715210100_earnings_consensus_snapshots_vintages.sql:29-35`),
reused verbatim.

---

## 12. Decisions

### 12.1 GO / RESHAPE / NO-GO

**RESHAPE.** See §0.

### 12.2 Best first estimate source

**Alpha Vantage `EARNINGS_ESTIMATES`**, confirmed live and free with the project's existing key,
multi-horizon, with built-in revision history — richer than Finnhub's paywalled thinner alternative
(§4.1–4.3). This is not "given existing credentials and quota" hand-waved — it is two live, verified,
read-only calls against the actual production key.

### 12.3 Can Finnhub's non-GAAP basis safely unblock prospective comparisons?

**Yes, prospectively only.** Verified verbatim, unconditional across the endpoint (§4.2). New
captures from approval-date forward may set `eps_basis = 'non_gaap'`. The 56 existing `null`-basis
rows are never rewritten.

### 12.4 Smallest defensible management-guidance source for Stage 0

**None — Stage 0/1 build no guidance capture at all** (§0, §4.6). If forced to name the smallest
defensible source for a future stage: SEC EDGAR 8-K EX-99.1 press releases via full-text search,
deterministic-parser-first.

### 12.5 What qualifies a company as a peer

Finnhub `/stock/peers?grouping=subIndustry` candidate, owner-reviewed and accepted into a versioned,
effective-dated `peer_group_versions` row. 5–15 members. Never `symbol_profiles.peers` read live.
Never an economic-relationship claim.

### 12.6 η construction

**Weighted median** initially (§7.3), per the user's own instruction. Regression-residual explicitly
deferred to a separately-tested Stage 2+ hypothesis, not a same-family variant.

### 12.7 Minimum coverage to build Stage 1

**Unresolved pending §4.4.** Proposed floor once the AV budget question is answered: ≥60 US symbols
with both FY+1 estimate coverage and an accepted ≥5-member peer basket, reaching the existing
`MIN_CROSS_SECTION = 5` floor on a real trading day. This number is a placeholder pending the budget
answer, not a commitment.

### 12.8 Evidence required before Stage 3 reports a number

Reuses the existing dimension-diagnostics floors verbatim (§8): `MIN_PREDICTIVE_DATES = 20`,
`MIN_EFFECTIVE_OBSERVATIONS = 12`, `MIN_CROSS_SECTION = 5`, horizon-aware independent-window spacing
(matching Codex's 2026-09-03 fix, not the flat 5-day rule that fix replaced).

### 12.9 Exact promotion gates

Reuses `edge_readiness_status`'s two-tier historical/validation gate structure verbatim — no new
promotion-gate design. A validated feature may request shadow review; it cannot self-promote past
that (matches `technical-calibration`'s own `maximumInfluence`).

### 12.10 What stays permanently display-only

Peer-move-style "what's happening" surfaces (raw revision news, a guidance calendar if ever built) —
never a trade signal without clearing the full Stage 3/4 gate, matching `/api/peer-moves`'s own
existing, unambiguous precedent.

### 12.11 Feasible India work now

None. A Stage 0b India capability probe (Alpha Vantage NSE/BSE symbol format, alternative India
estimate sources) is the only India work this document proposes, and it is not scheduled — it
requires a separate approval.

### 12.12 Does any part revive the relationship graph?

No, if the boundary in §3/§6/§7.4 is enforced. The risk is real enough to name explicitly: if a
future stage ever tries to reweight peers by "how much revenue symbol A gets from symbol B," that IS
the killed graph, under a new name, and must be refused.

### 12.13 What's missing from the originating prompt

The Alpha Vantage shared call-budget risk (§4.4) — the prompt asked about "provider cost, entitlement,
call volume, freshness, and free-cloud feasibility" in the abstract, but the concrete production
number (35–71 calls/day already in flight against a 25/day code default) was not knowable without
querying `provider_budget`, and it is the single largest feasibility gate on Stage 1's scope. Also
missing: what happens to this feature's evidence if the champion scorer's weights change mid-collection
(the existing dimension-diagnostics machinery handles this via `analysis_plan_version`; this feature
should adopt the same versioning discipline, not a bespoke one — noted here so a Builder doesn't have
to rediscover it).

---

## 13. Phased implementation (unchanged from the originating prompt's shape, reflecting §0's reshape)

### Stage 0 — source-contract probes
- Confirm the real Alpha Vantage plan/quota (§4.4) — **blocks everything else**.
- Measure `EARNINGS_ESTIMATES` coverage across Kairos's real US universe (not just IBM/EXEL), broken
  down by market-cap tier (§5).
- Confirm whether a `"fiscal quarter"` row beyond the immediate next quarter (i.e. a true Q+2) exists
  in a real multi-quarter response.
- No India probe scheduled (§4.5, §12.11) unless separately approved.
- Stop cheaply if coverage or basis integrity fails — same discipline as the relationship-graph P0.

### Stage 1 — immutable expectation capture (US only)
- Capture `earnings_expectation_snapshots` on the existing earnings-refresh cadence, symbol count set
  by Stage 0's budget answer.
- No scores, candidate admission, or trades. No guidance capture.
- Reuse Canonical Evidence Router provenance conventions; RLS per §11.6.

### Stage 2 — audited peer baskets and η (US only)
- `peer_group_versions`/`peer_group_members`, seeded from Finnhub, owner-reviewed acceptance.
- Compute η, `peer_revision_diffusion`, `reaction_residual` into `edge_signals`.
- No economic-relationship claims (§3, §12.12). No India.

### Stage 3 — feature and interaction shadows
- Register the five Stage-1-computable predeclared interactions (§8).
- Reuse `lib/edges/folds.ts`, the existing IC/FDR/cost machinery (§8).
- Surface through the existing `ShadowLifecycle`-based Upgrade Paths entry (§9), nested `stage` field.

### Stage 4 — promotion proposal only
- A passing shadow creates a reviewable challenger proposal via the existing promotion-proposal
  pattern. Cannot alter Champion weights, eligibility, sizing, stops, targets, exits, or broker
  actions. Owner approval mandatory.

**Guidance capture (management_guidance_observations, guidance-dependent interactions, LLM boundary
exercised) is a separately-approved Stage 2.5+/5+ decision, not scheduled by this document.**

---

## 14. Acceptance criteria

All 20 from the originating prompt are load-bearing here; mapped to the concrete mechanism that
enforces each:

1. Beat + future-guidance-cut stay separate facts — `earnings_calendar.eps_actual_first` (realized)
   and `management_guidance_observations` (guidance) are different tables, never merged.
2. Guidance midpoint is a generated column from low/high (§11.2) — low/high are never dropped.
3. Withdrawal is `is_withdrawal = true` with null low/high, never a numeric cut (§11.2).
4. A post-announcement estimate cannot masquerade as pre-announcement consensus — enforced by
   `available_at`/`captured_at` comparison, the same `isStrictlyPreAnnouncementVintage` discipline
   `earnings-pit.ts` already implements, reused not reinvented.
5. GAAP actual vs. adjusted estimate — `basis` column on both sides; comparison code must require
   matching, non-null basis (mirrors `/api/calendar/earnings/coverage`'s own `hasComparableConsensus`
   check verbatim).
6. Q+2 cannot join to a Q+1 actual — enforced by `fiscal_period` + `horizon_label` exact match in
   every join.
7. A later restatement cannot overwrite first-observed — append-only tables, no UPDATE except the
   existing `restated_eps` pattern on `earnings_calendar`, unchanged.
8. Peer membership at T = version at T — `peer_group_versions.effective_from/effective_to` filter,
   mandatory in every consumer (§11.3).
9. A peer reporting after the target cannot leak — dual timestamp check, target's `decision_ts`
   against both the peer's own snapshot `captured_at` and the peer basket's `effective_from` (§11.3).
10. US/India never pool — every table's `market` column is part of every aggregation `group by`,
    and India stays `not_applicable` throughout Stage 0–4 of this document (§4.5).
11. ETFs excluded — reuses `classifyInstrument`/`KNOWN_US_ETFS` (already used by the relationship-
    graph P0 probe and `lib/asset-classification.ts`), not a new classifier.
12. No single symbol/sector silently dominates — required leave-one-symbol/leave-one-sector influence
    checks (§8), reported alongside every IC number.
13. LLM extraction mutation cannot alter the money path — §10, no LLM output writes to a scored table
    directly; Stage 0/1 don't exercise the LLM path at all.
14. Empty/insufficient cohorts report unavailable, not zero/neutral — matches every dimension's
    existing `available: false` convention (`scoreAnalyst`, `scoreFundamentals`, etc.).
15. Upgrade Paths distinguishes scheduled/succeeded/fresh/measurable/eligible — nested `stage` field
    (§9), reusing `edge_readiness_status`'s own stage vocabulary rather than inventing a new one.
16. Replacing eligible cohort with all-scored causes a detector to fail — mutation test required in
    Stage 3's test suite, same discipline as this session's cost-fix mutation checks.
17. Relaxing as-of timestamp or basis predicate causes a detector to fail — mutation test required.
18. A shadow reproduces from immutable evidence IDs and formula versions — `source_call_id`,
    `extraction_version`, `analysis_plan_version` (adopted from dimension-diagnostics, §12.13).
19. Shows the feature adds value over the existing score, not mere return correlation — baseline-vs-
    baseline-plus-feature comparison on the identical eligible cohort is mandatory (§8), not a
    standalone IC number.
20. No implementation phase activates automatically — every stage transition in §13 requires the
    explicit approval gate in `AGENTS.md` ("Approved", "Proceed", "Code it", etc.).

---

## 15. Rollout / rollback

- Stage 0/1: no rollback needed — pure capture, no reads by any other system.
- Stage 2: peer baskets are versioned and additive; disabling the feature means the Upgrade Paths
  entry stops advancing its `stage`, nothing else changes.
- Stage 3/4: shadow-only by construction; rollback is "stop calling the shadow route," identical to
  every other measure-only shadow in this codebase.
- No stage in this document writes to any table another system reads, so there is no rollback
  scenario that requires a migration reversal.

---

## 16. Costs and operational risks

1. **Alpha Vantage shared budget — unresolved, top risk.** §4.4, §12.7, §12.13.
2. **Finnhub free-tier one-month depth** caps how much PIT history this feature (for actuals; it
   already reuses `earnings_calendar`) can ever have without a paid tier — a ceiling, not a bug.
3. **Coverage/selection bias by market-cap tier** — must be measured and reported, not assumed away
   (§5).
4. **`signal_score_history` schema drift** (§1.2 item 7) — a pre-existing, unrelated defect this
   review surfaced; flagged to Codex, not fixed here.
5. **Peer-basket review burden** — an owner-reviewed acceptance step (§7.1, §11.3) does not scale to
   thousands of symbols; acceptable at Kairos's current ~187-symbol US universe, would need a
   different design at 10x that size.

---

## 17. Unresolved decisions requiring Vaibhav's approval

1. Confirm the real Alpha Vantage plan/quota (§4.4) before any Stage 1 symbol count is set.
2. Approve or reject this document's Stage 0/1 scope (§13) as the first Builder task.
3. Confirm the peer weighting function for §7.2 once Stage 2 has enough data to choose between
   candidates (not a Stage 0/1 blocker, flagged for later).
4. Decide whether Stage 2.5+/5+ guidance extraction is ever built, and if so, approve its own
   architecture separately — this document deliberately does not schedule it.
5. Decide whether a Stage 0b India probe is worth running at all before India work of any kind.

---

## 18. Files a Builder would create or modify (Stage 0/1 only — nothing beyond is authorized by this document)

**Create:**
- `lib/data/earnings-expectations.ts` — `EARNINGS_ESTIMATES` fetch + capture, mirroring
  `earnings-pit.ts`'s structure (fail-soft per symbol, append-only writes).
- `supabase/migrations/<date>_earnings_expectation_snapshots.sql` — §11.1's table, RLS per §11.6.
- `app/api/calendar/earnings/expectations/coverage/route.ts` — coverage report, mirroring
  `/api/calendar/earnings/coverage/route.ts`'s exact structure and caveats style.
- `tests/earnings-expectations.test.ts` — capture logic, idempotency key, PIT-vintage rules.

**Do not touch:**
- `lib/data/earnings-pit.ts`, `earnings_consensus_snapshots` — left exactly as-is; this feature does
  not replace or migrate that table.
- Any file under `lib/data/scores.ts`, `lib/research-agent.ts`'s scoring/weighting logic, any
  eligibility/sizing/exit/order path — Stage 0/1 write no scored dimension.
- `symbol_profiles.peers` fetch logic — unchanged; Stage 2, not Stage 0/1, is when peer versioning
  begins, and even then the existing fetch is a candidate SOURCE, not something to rewrite.
- `lib/shadows/registry.ts`'s `ShadowLifecycle` type — reused, never redefined.
