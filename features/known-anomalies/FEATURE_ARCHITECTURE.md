# Known-Anomaly Backlog (PEAD-first) — FEATURE ARCHITECTURE

> Status: **Draft / not approved / implementation not allowed.** Design only.
> Last updated: 2026-07-15.
> Per-market applicability: **both** (US + India), but coverage differs — US analyst/earnings data is deep; India analyst coverage is thinner, so PEAD/revision signals may be US-first with India gated on data sufficiency (measure per-market, never assume parity). Currency never cross-summed.
> Update this file when: a listed anomaly is promoted to build, its data source/contract changes, or the measure-only→scoring gate changes.

## 1. Why this doc

A literature review (see §5) surfaced several well-established return anomalies Kairos is **not** exploiting despite already holding most of the data. This doc captures them as a prioritized, falsifiable backlog. Each is **measure-only first** in the existing Edge/Factor lab; none influences a score, size, or order until it clears the standard Feature-Registry / Validation / Champion-Challenger governance — same gate as every other dimension.

Ranking principle: **robustness × cheapness × data-we-already-have**, minus **data-coverage risk**. On that axis the relationship-graph is *last* (data-coverage gamble); PEAD is *first* (zero data risk).

## 2. Non-negotiable boundaries (inherited)

- Deterministic on the money path — **no LLM** sets a score/direction/size/gate/order. LLM (if any) only produces textual features that are themselves measured, off the money path.
- **Measure-only → shadow → governed promotion.** A new anomaly registers as a versioned `edge_*` signal, is scored by EdgeIC over forward-return labels, and can only affect real scoring via an approved Challenger / feature-registry change.
- **Per-market** (US/India independent); currency never cross-summed.
- **Long-only for new positions.** A bearish anomaly reading suppresses/deprioritizes a long or feeds the *separate governed* downside path — never places a short.
- **Point-in-time / no lookahead.** Every signal uses only data whose `available_at` ≤ decision time. Earnings/filing timestamps are knowledge-time, not event-time.
- Reuse the **Canonical Evidence Router** for provider acquisition; no parallel provider calls or provenance store.

## 3. The backlog (priority order)

### P1 — Post-Earnings-Announcement Drift (PEAD)  ★ recommended next build
- **Claim (very robust):** stocks with large positive earnings surprises drift *up* for weeks-to-months; large negative surprises drift down. One of the most persistent anomalies in asset pricing.
- **Signal (deterministic):** standardized surprise = (actual − expected) / dispersion, from the data we already fetch (earnings calendar + analyst consensus / prior-quarter series). Both analyst-based and time-series-based surprise; combining them strengthens the drift (§5). Sign of surprise + magnitude → a measure-only edge with a multi-week horizon.
- **Data we already have:** earnings calendar, analyst consensus (Webull), historical EPS. Marginal new data ≈ none. **Zero coverage risk.**
- **Textual upgrade (later, off money path):** earnings-call tone / negative sentiment interacts with the surprise to widen the drift (PEAD.txt). LLM produces the tone feature; it is measured, never scores directly.
- **Horizon fit:** drift persists beyond our swing window, so PEAD can inform both entry timing and hold length.

### P2 — Analyst-revision momentum
- **Claim:** analysts are slow to fully incorporate revenue/earnings surprises; the *direction and momentum of estimate revisions* predicts continued drift.
- **Signal:** rolling change in consensus EPS/target + revision breadth. We already pull analyst consensus (Webull) — this systematizes the revision *delta*, which we currently ignore.
- **Coverage risk:** low (data already fetched).

### P3 — "Lazy Prices" (filing language change)
- **Claim (Cohen-Malloy-Nguyen):** firms that materially *change* their 10-K/10-Q language year-over-year subsequently underperform; no-change firms are steadier.
- **Signal:** cosine / edit-distance similarity of consecutive filings' text (MD&A / risk factors). LLM-light (embeddings or plain text similarity), off money path; the *similarity score* is the measured feature.
- **Data:** free via EDGAR full-text. Moderate build (filing diffing pipeline).

### P4 — Second tier (capture, not scheduled)
Short-interest / squeeze; 13F institutional-flow changes; options-implied skew/put-call (we read options lightly); calendar/seasonality drift. Each is a candidate edge; none is prioritized until P1–P3 prove out.

## 4. Phased rollout (applies per anomaly)

1. **Measure-only edge**: register in `edge_catalog` / `edge_signals` / `edge_signal_inputs`; compute deterministically per covered name per market; write to `edge_ic_history`.
2. **EdgeIC evaluation**: forward-return correlation over `decision_observations × observation_labels`, per market, after costs, with multiple-testing correction (many anomalies tested ⇒ deflate).
3. **Shadow**: run alongside the champion, record what it *would* tilt, no money effect.
4. **Governed promotion**: only via an approved Validation-Engine Challenger or feature-registry change; per-market; never auto.

## 5. Research grounding
- **PEAD**: [Post–Earnings-Announcement Drift — overview](https://en.wikipedia.org/wiki/Post%E2%80%93earnings-announcement_drift); [Quantpedia — Post-Earnings Announcement Effect](https://quantpedia.com/strategies/post-earnings-announcement-effect); textual form: [PEAD.txt, Philadelphia Fed WP21-07](https://www.philadelphiafed.org/-/media/frbp/assets/working-papers/2021/wp21-07.pdf). Combining analyst + time-series surprise strengthens drift.
- **Economic-link / customer momentum** (the relationship-graph prior, kept in its own doc): [Cohen & Frazzini (2008)](https://pages.stern.nyu.edu/~afrazzin/pdf/Economic%20Links%20and%20Predictable%20Returns%20-%20Cohen%20and%20Frazzini.pdf).

## 6. Open decisions (for owner / Codex)
1. **PEAD surprise definition**: analyst-consensus vs time-series vs combined? Recommend combined (strongest per lit), fail-closed when analyst dispersion is missing.
2. **PEAD horizon**: how long to hold the drift given our swing/position styles + costs?
3. **Sequencing**: confirm PEAD before the relationship-graph P0 feasibility study (both cheap; PEAD has no coverage risk).
4. **Multiple-testing discipline**: since we're now testing several anomalies, adopt the Deflated-Sharpe / PBO gate from `features/advanced-learning` before *any* promotion, so we don't overfit the backlog.
