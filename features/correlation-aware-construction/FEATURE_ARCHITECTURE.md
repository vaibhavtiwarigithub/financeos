# Correlation-Aware Portfolio Construction — FEATURE ARCHITECTURE

> Status: **Reviewed / measurement prerequisite required / P0-P1 activation not approved.** Design only.
> Last updated: 2026-07-16.
> Per-market applicability: **both** — correlation **gating/sizing is strictly per-market** (US/USD and India/INR pools are separate; never cross-summed). Cross-market correlation is **display-only awareness, never a gate**.
> Sequencing: folds in **after** the in-flight Codex paper-autonomy fixes (they own `paper-trade`/`position-monitor` right now) and alongside the holdings-priority research fix.
> Update this file when: the risk inputs, estimator, selection rule, or the gating/display boundary change.

## 0. 2026-07-16 adversarial correction (authoritative over the earlier draft)

The earlier draft overstates what is reusable from Holding Risk. Do **not** wire P0/P1 as originally written:

- Holding Risk computes pairwise correlations in memory only among **already-held** names. It persists per-name cluster summaries, not the pairwise matrix needed to estimate a new candidate's marginal risk.
- A new candidate is not part of that Holding Risk run, so there is no measured candidate-to-book correlation to consume at entry.
- The persisted per-holding `beta` is currently derived from sector beta in the account enrichment path; it is not a uniformly measured symbol-to-benchmark beta contract. India can replace the account-level aggregate beta, but that does not make every persisted holding beta measured.
- PaperTrader already estimates candidate daily volatility, but the India implementation fetches candles synchronously on the entry path and the US path depends on whatever history exists in `price_cache`. This does not satisfy the proposed no-provider-call, point-in-time evidence contract.
- P1 intentionally reorders already-eligible candidates. Therefore “no previously rejected name becomes eligible” can apply only to **safety-gate rejection**, not selection rank; otherwise P1's stated purpose is impossible.

### Required prerequisite before activation

1. During ResearchAgent's existing candle fetch, append a compact, immutable per-symbol return observation with `market`, `symbol`, `as_of`, `available_at`, provider/source, return dates, daily vol, benchmark beta when measurable, overlap count, and input fingerprint. Do not make another provider call for this record.
2. Build candidate-to-held pair estimates from observations where `available_at <= decision_at`, with at least 60 shared sessions, deterministic shrinkage, and sector-proxy fallback explicitly labeled `low_confidence`.
3. Run the measured penalty in **shadow only** and persist baseline size/rank, shadow size/rank, evidence IDs, fallback reason, and every eligibility flip.
4. Activate P0 only after a frozen-cohort test proves no order is larger and no baseline safety rejection becomes eligible. Activate P1 separately after shadow evidence shows the reordering improves diversification without weakening score, mandate, liquidity, capacity, or execution gates.

Until those prerequisites exist, the production constructor remains on its current conservative volatility/sector-proxy behavior. Faking candidate correlations from held-name cluster averages is prohibited.

## 1. Verified current state (not assumed — read from code)

The machinery is ~80% built and **fed fake inputs**:

| Piece | Reality |
|---|---|
| Sector cap (`max_positions_per_sector`, default 3, market-local) | **Enforced** ✅ |
| Portfolio Constructor (`lib/portfolio/constructor.ts`) — name/sector/gross/**vol/correlation** rules at entry | **Runs**, and is correctly **subtractive** ("never increases a size, never force-sells the book") ✅ |
| `beta`, `dailyVol` inputs | **`paper-trade` passes `beta: null, dailyVol: null`** → constructor falls back to a **flat `0.02` (2%/day) vol for every name** ❌ |
| Correlation used in the vol budget + Rule-5 haircut | **Proxied from sector**: `corr = sameSector ? CORR_SAME_SECTOR : CORR_CROSS_SECTOR` — two constants, **not measured co-movement** ❌ |
| `max_avg_pairwise_corr` (0.7) | Explicitly *"informational bound; not solved for directly"* ❌ |
| Real measured beta + aligned-return correlation | **Computed daily** by holding-risk (`lib/risk/holding-risk.ts`, `lib/risk/correlation.ts` → `computeCorrelationClusters`) — but powers the **Risk Analytics display only**, never the entry decision ❌ |

**Consequence:** two instruments in different nominal "sectors" that move identically (e.g. a semi ETF and a semi name; two USD-revenue India IT names) pass the entry gate as if diversifying. The knobs exist; the numbers exist; **the wiring between them does not**.

## 2. Why this matters more than raising the position cap

The research budget already caps position count (a US run scores ~30 of ~102; 72 deferred). Once holdings are re-scored daily, 10/market ≈ 20 holdings ≈ most of a run's capacity, leaving ~10 discovery slots. **15-20/market would starve discovery or holdings-freshness.**

So the lever is **quality of the 10, not quantity**: 10 genuinely uncorrelated names beat 15 correlated ones. **Do this before revisiting the cap.**

## 3. Non-negotiable boundaries

- **Deterministic** — no LLM anywhere in estimation, selection, or sizing.
- **Subtractive only** — preserve the constructor's invariant: rules may only **shrink** a size or reject a new entry. Never increase a size, **never force-sell an existing position** because a correlation estimate moved.
- **Per-market gating only.** Correlation/vol constraints are computed and applied **within** a market's pool. Cross-market correlation is **informational** and must never size, gate, or reject.
- **Point-in-time.** Correlation/beta/vol must be computed from returns **available at the decision timestamp**. No lookahead; a decision cannot use a correlation estimated with later data.
- **Fail-safe, not fail-open.** Missing/insufficient risk inputs must degrade to the **current conservative behavior** (sector proxy), never to "no constraint".
- **No new provider calls on the entry path.** Reuse the existing daily holding-risk computation + `price_cache`; entry must not burst providers.

## 4. Statistical rigor (why the naive version is wrong)

At 10-24 names with limited history, **sample correlation matrices are notoriously unstable**. Naive implementation will reject good trades on noise.

1. **Shrinkage** (Ledoit-Wolf style) toward a structured target (sector-average or identity) — never raw sample correlation.
2. **Minimum overlapping history** (~60 sessions) per pair; below it, **fall back to the sector proxy** and label the estimate `low_confidence`.
3. **Penalty, not hard gate.** Correlation reduces a candidate's effective attractiveness/size; it does **not** hard-reject at `corr > 0.7`. A hard threshold on a noisy estimate is a coin-flip rejector.
4. **Beta ≠ correlation — keep both, they answer different questions:**
   - **Beta (to market benchmark)** → *how much market exposure does the book carry?* (10 names all at β 1.5 = a 1.5× levered market bet, even if uncorrelated to each other.)
   - **Pairwise correlation / clusters** → *how redundant are these names with each other?*
   Both are needed; conflating them hides one of the two risks.
5. **Estimate provenance**: every risk input stored with `as_of`, source, and `confidence` so a decision can be audited and a low-confidence input can be treated conservatively.

## 5. Phases

### P0 — Wire the real inputs (highest value, cheapest)
Feed measured `beta` / `dailyVol` / pairwise correlation — **from the existing daily holding-risk computation** — into the constructor at entry, replacing `beta: null, dailyVol: null` and the sector-proxy constants. Apply shrinkage + min-history fallback to the sector proxy. **Turns existing dead knobs live with no new data source and no new provider calls.**

### P1 — Correlation-penalized selection
Rank candidates by **score per unit of *marginal* risk added to the current book**, not raw score. Greedy: for each candidate, compute its marginal contribution to book variance given current holdings; penalize accordingly.

> This is the owner's stated intent: *a 70-score name uncorrelated to the book should be able to beat an 85-score name that is a clone of what we already own* — and should be able to displace it as a second/third choice.

Deterministic + auditable: persist the penalty and the marginal-risk term in the decision rationale so "why did it pick #4 over #2" is answerable.

### P2 — "These move together" view (owner-facing)
Surface correlation **clusters** (reuse `computeCorrelationClusters`) on the Risk/Portfolio surface: which stocks/ETFs actually co-move, with coverage + confidence labels. Display-only.

### P3 — Cross-market awareness panel (display-only, never gates)
Show US↔India co-movement at the **owner/total** level — the blind spot per-market views structurally cannot see (e.g. India IT is largely USD/US-client revenue → correlates with US tech; a US tech drawdown can hit **both** pools at once).

**Hard requirement:** NSE closes before NYSE opens — **naive same-day cross-market correlation is an artifact**. Must use **lag-aligned** returns (India day T vs US day T−1, or a documented overlapping-window convention) and treat **INR/USD as its own factor**. Label explicitly: *informational; not used for sizing or eligibility.*

## 6. Acceptance / rollback
- P0 must be a **no-op-or-safer** change: with real inputs the constructor may only shrink or reject relative to today's behavior on the same cohort; prove on a frozen cohort that no position gets *larger* and no previously-rejected name becomes eligible.
- Missing inputs ⇒ identical behavior to today (sector proxy).
- Rollback = a config flag reverting to the sector-proxy constants; no schema loss.
- Tests: shrinkage estimator determinism; min-history fallback; PIT correctness (no lookahead); subtractive invariant (never upsizes / never force-sells); per-market isolation (US inputs never enter India's book).

## 7. Open decisions (owner / Codex)
1. **Estimator**: Ledoit-Wolf shrinkage vs simpler constant-correlation shrinkage? (Recommend constant-correlation target first — fewer moving parts at N≈10-24.)
2. **Penalty strength**: how hard should correlation discount score in P1? Must be a **config value**, not hardcoded, and ideally learnable later — but fixed until the learner has a validated edge.
3. **Beta budget**: should the book carry an explicit **portfolio-beta cap** (distinct from vol/correlation), so 10 uncorrelated-but-all-high-beta names still get constrained? (Recommend yes, config, default off until measured.)
4. **Cross-market lag convention**: India T vs US T−1, or overlapping-window? Must be fixed + documented before P3 renders a number.
5. **Do NOT raise the position cap until P0+P1 ship** — confirm this sequencing.
