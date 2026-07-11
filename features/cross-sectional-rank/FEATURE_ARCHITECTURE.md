# Cross-Sectional Ranking — Feature Architecture

**STATUS: IMPLEMENTED (P0–P2), OFF by default (`entry.rank_pct_min` = 0.0). Migration 151 applied 2026-07-11.**

**Last updated:** 2026-07-11
**Author:** Claude (P0–P2 shipped: `lib/scoring/rank.ts`, cron Pass 2, genome param, migration 151. P3–P4 validation-replay/learner-proposal still pending.)

> **Open flag RESOLVED (2026-07-11) — "top-3 by analyst_score win" (§9 borderline item):** the rank gate governs **cross-group admission only**; final ordering of admitted candidates stays by `analyst_score` (`PaperTrader.order("analyst_score", desc)` unchanged). Within a comparable group `rank_pct` is monotonic in `analyst_score`, so intra-group top ordering is byte-identical, and under today's single-/small-group degraded case (the common case) rank selection and raw-score selection are identical. The divergence only appears once the universe is large enough for multiple valid sector groups — precisely when cross-sectional rank has value. This is behavior-neutral today because the feature ships OFF (`rank_pct_min` default 0.0) and can only activate via a validated, owner-promoted challenger. No conflict with the locked CLAUDE.md decision.
**Scope:** US equities, US ETFs, India NSE equities; long-only new positions; 2–20 trading-day swing horizon.
**Parent doctrine:** `features/scoring-methodology/FEATURE_ARCHITECTURE.md` §5 ("Universe and comparable groups") and §3 ("comparable-universe rank + uncertainty"). This document is the concrete, buildable slice of that named P1 gap.

---

## 1. Problem statement (the named P1 gap)

Today a candidate becomes a `long` entry **only** through an **absolute** per-stock gate:

- `lib/research-agent.ts` (`processSymbol`, ~line 1180):
  ```
  signalDirection = analystScore >= (scoreThreshold ?? 60) ? "long" : "neutral";
  ```
  `scoreThreshold` comes from the champion genome (`genome.entry.score_threshold`, bounded [50,75]) → `strategy_config.score_threshold` → `min_analyst_score` → 60.
- `app/api/agents/paper-trade/route.ts` (~line 150) re-applies the **same** absolute floor:
  ```
  .eq("status","pending").eq("direction","long")
  .gte("analyst_score", scoreThreshold)
  .order("analyst_score", { ascending: false }).limit(10)
  ```

An absolute 0–100 composite is a **calibration-fragile** entry rule. `analyst_score` is a renormalized weighted sum (`lib/scoring/weighted-score.ts`), not a probability, so a fixed cutoff of 60 silently means "trade more" on strong tapes and "trade nothing" on weak tapes even when the *relative* best names are unchanged. It cannot answer the question a swing book actually needs: **"Is this the strongest candidate available in its comparable group today?"**

### What already exists (do NOT rebuild)

The **measure-only** half of cross-sectional rank is already shipped:

- **Migration 137** (`supabase/migrations/137_universe_snapshots.sql`) created `universe_snapshots` and `universe_snapshot_scores(universe_snapshot_id, symbol, analyst_score, rank_pct, decision_observation_id)`.
- **Migration 136** added `decision_observations.universe_snapshot_id`.
- The research cron (`app/api/agents/research/cron/route.ts`, ~lines 152–215) already:
  1. inserts one `universe_snapshots` row per run (`source: "mixed"`),
  2. after all symbols score, computes `rank_pct = (# symbols scoring below s) / (n-1)` over the whole run, and
  3. writes `universe_snapshot_scores`.
- `processSymbol` accepts `universeSnapshotId` and stamps it on `decision_observations`.

**Gaps this feature closes:**

1. The existing `rank_pct` is **never consumed** by any selection path — it is logged and forgotten.
2. It is computed over a **mixed universe** (US equities + ETFs + metals + region ETFs + India names all pooled), violating scoring-methodology §5 ("never rank ETFs against companies", per-market/sector comparable groups, minimum sample sizes). It also ranks **all** scored symbols including thin-evidence / vetoed ones, violating "rank composites **after** data-quality gates".
3. Rank is computed **after** the per-symbol entry decision is already written, so it structurally cannot gate entry today.

---

## 2. Design goals & non-negotiables

**Goal:** make cross-sectional rank an **actionable, correct** input to the new-entry decision — layered on top of (not instead of) a conservative absolute floor — while leaving sizing, execution, and the SELL-for-holdings path untouched.

Respect these locked decisions (from `CLAUDE.md` and scoring-methodology §2):

- Rank is a **scoring refinement**, not a regime switch. **No explicit bull/bear mode** is introduced (§3).
- **Dual-bucket momentum/value** screener is unchanged; rank sits downstream of scoring, not inside discovery (§3).
- **≤ 3 screener candidates/day**; rank can only *reduce* the actionable set, never expand it (§4).
- **Long-only for new positions**; the held-position exit branch (`isExitSignal`) is not touched (§4).
- An LLM never generates rank, score, direction, or eligibility (scoring-methodology §2).
- Comparable-universe transforms use a **recorded** reference universe for the same market/date; **the three daily finalists are not a valid reference universe** (scoring-methodology §5 / §2).

---

## 3. Where rank must live in the pipeline

Rank is intrinsically a **whole-universe** operation: a symbol's percentile is undefined until every peer in its comparable group has scored. The current pipeline decides `direction`/`entry_eligible` **per symbol, streaming**, before peers finish. Therefore rank cannot be a drop-in inside `processSymbol`'s existing gate.

**Chosen shape: a deterministic second pass in the cron, after scoring, before PaperTrader.**

```text
Pass 1 (unchanged): processSymbol × N  → writes analyst_score, per-dim scores,
                    decision_observations, agent_signals(direction, status='pending')
                    Data-quality state already computed here:
                      thinEvidence, includedDims, evidence_confidence,
                      breakdown veto (baked into technical_score), abstain

Pass 2 (NEW, deterministic, no LLM): rankAndGate(runId, universeSnapshotId)
   a. Build the ELIGIBLE ranking pool = scored symbols that passed data-quality gates
   b. Partition pool into comparable groups (market × asset-type × sector/bucket)
   c. Compute rank_pct within each group (empirical percentile)
   d. Persist rank_pct + rank_quality to universe_snapshot_scores (replaces the
      current naive mixed-pool computation)
   e. Apply the rank+floor entry policy → update agent_signals.direction/status
      for NEW candidates only (holdings & exits untouched)

PaperTrader (minimally changed): consumes the gated signals as today
```

Why a second pass and not gate inside `processSymbol`:
- `decision_observations` is **append-only** (mutation-blocking trigger, per scoring-methodology §9) — we must not rewrite the PIT observation. Rank is logged as an *additional* `universe_snapshot_scores` row keyed to the observation, exactly what migration 137 was built for.
- `agent_signals` **is** mutable (PaperTrader already flips `status` there) — it is the correct surface to flip a rank-rejected candidate from `direction='long'` → `neutral`/`status='rank_rejected'`.

Two placement options for Pass 2, both acceptable; recommend **(A)** for auditability:

- **(A) Cron reconciliation (recommended).** Extend the existing block in `research/cron/route.ts` (~line 193) that already computes `rank_pct`. It runs once, sees the whole universe, writes correct grouped ranks, then applies the gate to `agent_signals` before it chains PaperTrader (~line 249). Fully deterministic, easy to unit-test, one write site.
- **(B) PaperTrader join.** Leave `agent_signals` alone; have PaperTrader join `universe_snapshot_scores` and apply the rank gate at selection. Less invasive to research, but scatters the entry policy across two agents and re-derives the pool at fill time. Rejected as primary.

> **CLAUDE.md coupling note:** `decision_observations.universe_snapshot_id` and the whole `universe_snapshot_scores` table must be confirmed present in the target DB before Pass 2 ships (they are migrations 136/137). Per the global "verify migration before merging" rule, a `list_migrations` / `information_schema` check is required at build time; the new columns in §7 add migration ~145.

---

## 4. Comparable groups & the eligible ranking pool

### 4.1 Data-quality gates run BEFORE ranking (the "rank composites after gates" requirement)

A symbol enters its comparable group's ranking pool **only if** all of the following hold (all already computed in Pass 1):

| Gate | Source | Rejected symbols |
|---|---|---|
| Not thin evidence | `isThinEvidence(includedDims)` (`weighted-score.ts`) — ≥2 usable dims | excluded from pool, `direction=neutral` (already) |
| Not abstained | `signalDirection !== "neutral"` from Pass 1's mechanical gate | excluded |
| Breakdown veto not fired | already folded into `technical_score` cap 20 (`detectBreakdownVeto`) | stays in pool but scores low naturally |
| Evidence confidence floor | `decision_observations.evidence_confidence >= RANK_MIN_CONF` (default 0.60, mirrors scoring-methodology §7) | excluded from pool |
| Is a **new** candidate | `isHeld === false` | holdings never enter the new-entry rank pool |

Excluded symbols still get a `universe_snapshot_scores` row with `rank_pct = null, rank_quality = 'excluded_'<reason>` for auditability, but are **not** rank-eligible for entry. This is the operational meaning of "rank composites after data-quality gates".

### 4.2 Comparable groups (scoring-methodology §5, made concrete)

Partition the eligible pool by:

- **US equity / ADR:** `market='us'` × sector (`decision_observations.features.fundamental.sector`) when the sector has **≥ RANK_MIN_GROUP_EQUITY (20)** eligible names that day; else fall back to `market='us'` × asset-type=equity (all US equities pooled).
- **US ETF:** `market='us'` × ETF category (broad / sector / thematic / leveraged-excluded). **Never** ranked against single companies. Given daily ETF counts are tiny (metals basket + region ETFs, typically < 5), ETFs almost always fall to the degraded path (§4.3).
- **India equity:** `market='india'` × NSE sector when **≥ RANK_MIN_GROUP_INDIA (15)**; else `market='india'` × large/mid liquidity bucket.

Groups are keyed off fields already present in `decision_observations.features` and `entry` metadata — no new fetch. Sector for US comes from AV `OVERVIEW.Sector` (already stored in fundamental evidence); India sector from the screen cache / Yahoo mapper.

### 4.3 Small-group degraded path (the "three finalists are not a universe" guard)

If a comparable group has fewer than its minimum-sample threshold **eligible** names:

- Do **NOT** invent a percentile from 3–5 names.
- Mark `rank_quality = 'degraded'` and fall back to a **pre-registered fixed transform**: `rank_pct := clamp01((analyst_score - RANK_FLOOR_LO) / (RANK_FLOOR_HI - RANK_FLOOR_LO))` with fixed constants (e.g. 45 → 0, 80 → 1). This makes the rank gate collapse to a slightly-softened absolute gate exactly when there is no valid cross-section — the honest degenerate behavior.
- A degraded rank may drive **paper** selection but is flagged so the learner and any future live path can treat it as lower-quality evidence.

Because the realistic daily universe today is small (~6 screener + watchlist + holdings, one market per cron), **most runs will start on the degraded path.** That is acceptable and honest: the value of true cross-sectional rank grows as the PIT universe widens (scoring-methodology §5/§12). The architecture is correct now and improves automatically as universe breadth increases.

---

## 5. How rank composes with the genome threshold (the entry policy)

**Hybrid gate = absolute floor AND relative rank.** Both must pass for a NEW long entry:

```text
entry_long  ⟺  (analyst_score >= score_threshold)          # existing genome floor, unchanged
             AND (rank_pct     >= rank_pct_min)             # NEW cross-sectional gate
             AND passed §4.1 data-quality gates
             AND not thin evidence
```

Rationale for **AND**, not replace:

- **Floor alone** (today) trades the weak-tape problem described in §1.
- **Rank alone** would trade "the best of a bad universe" on a day when *every* candidate is weak — a real failure mode the absolute floor exists to prevent. Keeping the floor means: on a day where the top-ranked name still can't clear an absolute conviction bar, we trade nothing. This is the correct humility prior (doctrine §3).
- **AND** = "trade only names that are both objectively decent (floor) **and** the relative best available (rank)." This is what a disciplined swing book does and it is the tightest, safest composition.

### Genome extension

Add one evolvable parameter to the genome (`strategy_versions.genome`, documented in `docs/arch/09-learning-loop.md`):

| Parameter | Range | Default | Notes |
|---|---|---|---|
| `entry.rank_pct_min` | 0.0 – 1.0 | **0.0** (feature OFF) | Minimum within-group percentile for a NEW long. `0.0` = today's behavior exactly (rank never rejects). Champion promotion bounds it, e.g. [0.5, 0.9]. |

**Backward-compatibility is exact:** a champion with no `rank_pct_min` (or `0.0`) reproduces current selection byte-for-byte. This makes the whole feature a **no-op until a challenger carrying `rank_pct_min > 0` is validated and promoted** — satisfying "no scoring change affects live until owner promotion" (scoring-methodology §15) and the CLAUDE.md pushback mandate.

### Top-3/day preservation

Rank is a **filter that only removes candidates.** It never lifts the screener's ≤3/day target, PaperTrader's `limit`, position caps, or cash constraints. When `rank_pct_min > 0`, the actionable set is a **subset** of today's absolute-floor survivors, so daily churn can only **decrease**. No conflict with the top-3 rule.

> **Ordering note (CLAUDE.md "top 3 by analyst_score win"):** within a single comparable group, `rank_pct` is a monotonic transform of `analyst_score` — so the *ordering* of the top-3 within a group is identical to ordering by raw score. Rank changes **which** names clear the bar (relative-to-peers), not the intra-group ranking of those that do. PaperTrader's `.order("analyst_score", desc)` can stay. No locked-decision conflict.

---

## 6. Rank vs the calibrated P(win) model — feature, not gate (yet)

`lib/validation/calibration.ts` fits a logistic P(win) over the 5 dimension scores (`DIMS`) and gates the `pwin_logistic` artifact on walk-forward ECE. Two candidate roles for rank:

- **As a GATE (selection):** covered in §5 — this is the actionable use now, and it is deterministic and testable.
- **As a FEATURE (calibration/sizing):** `cross_sectional_rank_pct` is a genuinely different axis from raw dimension scores (it encodes *relative* strength, which the absolute dims cannot). It is a strong candidate to become a 6th feature in the P(win) logistic.

**Recommendation: log rank as a feature now; do NOT feed it into the live P(win) model until it earns an IC track record.** This mirrors exactly how `analyst` consensus and `days_to_earnings` are already handled in `processSymbol` (logged into `decision_observations.features`, graded by the learner, promoted through the IC-gated Feature Registry — never wired straight into live sizing). Concretely:

- Pass 2 writes `features.cross_sectional.rank_pct`, `rank_quality`, `comparable_group_key`, `group_n` into the observation's companion evidence (via `universe_snapshot_scores`, since `decision_observations` is append-only and already written in Pass 1).
- The learner's IC tooling (`lib/edges/ic.ts`) can then measure Spearman IC of `rank_pct` vs forward returns per market/setup/horizon.
- Only after rank clears the same OOF/IC bar the calibration §10 rules demand does adding it to `DIMS` (a `deterministic_v2` concern) get proposed. **Not in this feature's scope.**

This keeps the money path (sizing off calibrated P(win)) unchanged while rank proves itself.

---

## 7. Persistence & migrations (additive only)

Reuse migration 137 tables; add columns, do not create a parallel truth store (scoring-methodology §15).

**Migration ~145 (verify next number at build time — repo is at 144):**

```sql
-- universe_snapshot_scores: richer rank provenance (all nullable, additive)
alter table public.universe_snapshot_scores
  add column if not exists rank_quality        text,      -- 'ok' | 'degraded' | 'excluded_thin' | 'excluded_conf' | 'excluded_held'
  add column if not exists comparable_group_key text,     -- e.g. 'us:equity:technology'
  add column if not exists group_n              int,      -- eligible names in the group that day
  add column if not exists rank_eligible        boolean;  -- passed §4.1 gates → counted in the group

-- agent_signals: record why a candidate was rank-rejected (audit; PaperTrader already
-- reads status). No new features blob — canonical PIT stays in decision_observations.
alter table public.agent_signals
  add column if not exists rank_pct        numeric,
  add column if not exists rank_rejected   boolean default false;
```

- `decision_observations` gets **no** new columns — `universe_snapshot_id` (136) already links it; rank lives in the companion `universe_snapshot_scores` row (keyed by `decision_observation_id`). This respects the append-only invariant.
- New status value: `agent_signals.status = 'rank_rejected'` for candidates that cleared the floor but failed the rank gate (distinct from `expired`/`neutral` so the Research Journal can explain "scored well but wasn't the best available today").
- Range check `rank_pct ∈ [0,1]` already exists on `universe_snapshot_scores`; mirror as `NOT VALID` on `agent_signals` then validate.

---

## 8. Learning-loop / validation evaluation of a rank challenger (no regime logic)

A challenger that sets `rank_pct_min > 0` must be replayable by the Validation Engine on held-out folds **without** any regime branch.

- **Reference universe reconstruction:** the validation replay already reads `decision_observations` per PIT day. To evaluate the rank gate, it joins `universe_snapshot_scores` (or recomputes grouped `rank_pct` from the day's eligible observations using the same §4 grouping function — the function must be **shared** between live Pass 2 and validation, exactly as `computeWeightedAnalystScore` is shared between `research-agent.ts` and the engine). This guarantees the challenger is graded on the identical rank rule that would run live.
- **Walk-forward integrity:** rank is computed **within each PIT day** from data available that day — it introduces **no** look-ahead (a day's percentile only uses that day's cross-section). Purge/embargo rules are unchanged.
- **Metrics:** top-K precision / top-minus-median spread (scoring-methodology §10) are the natural fit — a rank gate should *improve* precision@K if it has edge. Champion-vs-challenger is paired on the same opportunity set.
- **Eligibility gates unchanged:** Sharpe ≥ 0.5, win rate ≥ 40% (docs/arch/09). No new gate needed; rank is just another genome dimension the engine already knows how to replay.
- **No regime detection:** the challenger contains a single scalar `rank_pct_min`. Its adaptivity is emergent (on a weak day fewer names clear the paired floor+rank bar), exactly the "scoring naturally adapts" principle the CLAUDE.md pushback mandate protects. There is no bull/bear state, no regime table read for the gate.

---

## 9. Explicit non-conflict checklist (CLAUDE.md locked decisions)

| Locked decision | How this design respects it |
|---|---|
| No explicit bull/bear regime switching | Rank is a within-day percentile scalar; no regime state, no mode switch. §2, §8. |
| Dual-bucket momentum/value screener | Untouched — rank is downstream of scoring, screener discovery unchanged. |
| ≤ 3 screener candidates/day | Rank only removes candidates from the actionable set; churn can only fall. §5. |
| Top-3 by analyst_score win | Within a comparable group, `rank_pct` is monotonic in `analyst_score`; intra-group top ordering is identical. §5. |
| Long-only for NEW positions | Gate applies only to `isHeld === false` candidates; the `isExitSignal` SELL path is not read or modified. §4.1, §5. |
| SELL capability for existing holdings | Holdings never enter the rank pool; their exit signals bypass the gate entirely. §4.1. |
| No agent complexity before the weekly learner has run | Ships **OFF** (`rank_pct_min` default 0.0); becomes active only via a validated, owner-promoted challenger. §5. |
| LLM never generates score/direction/eligibility | Pass 2 is fully deterministic, no LLM call. §3. |

**Only borderline item:** "top 3 by analyst_score win" *could* be read as "selection must be by raw absolute score." This design keeps raw-score ordering **within** a comparable group (monotonic) and only changes the *cross-group admission* rule. If the owner intends the phrase to mean "never let a lower-raw-score name beat a higher one anywhere," note that with a **single** comparable group (the common degraded/small-universe case today) the two are identical — so the divergence only appears once the universe is large enough to have multiple valid sector groups, which is precisely when cross-sectional rank has value. Flag for explicit owner sign-off.

---

## 10. Phased build plan & effort

| Phase | Deliverable | Gate to advance | Effort |
|---|---|---|---|
| **P0 — measure-only correctness** | Replace the cron's naive mixed-pool `rank_pct` (research/cron ~L193) with the §4 grouped, gated computation + migration ~145 columns. Rank still **not** consumed for entry. Shared `computeComparableRank()` in `lib/scoring/`. | Unit tests: grouping, small-group degraded path, exclusion reasons, monotonicity within group. Migration verified applied. | **~1.5 days** |
| **P1 — genome plumbing (still off)** | Add `entry.rank_pct_min` to genome type + `DEFAULT_GENOME` (0.0), bounds at promotion, docs/arch/09 update. No behavior change. | Byte-stable selection with default genome (regression test). | **~0.5 day** |
| **P2 — Pass 2 entry gate + shadow** | `rankAndGate()` in cron after scoring: flip `agent_signals` for rank-rejected NEW candidates; write `rank_rejected`/`status='rank_rejected'`; Research Journal reason. Runs **only** when champion `rank_pct_min > 0`. Add shadow scoring so a shadow challenger's rank decisions are recorded (mirrors existing shadow_decisions). | Acceptance tests §11; shadow evidence accrues; no live/paper change while champion default. | **~2 days** |
| **P3 — validation replay** | Shared rank function wired into Validation Engine; challenger with `rank_pct_min` replayable on held-out folds with top-K precision metric. | Paired champion/challenger replay reproduces live rank decisions; walk-forward no-leakage test. | **~2 days** |
| **P4 — learner proposes rank challengers** | Learner's `propose_challenger` may set `rank_pct_min`; IC of `rank_pct` feature reported. Owner promotes if validated. | Same Sharpe≥0.5 / win-rate≥40% gates; owner promotion. | **~1 day** |
| **(later) P5 — rank as P(win) feature** | Out of scope here. Only after rank clears the IC/OOF bar (§6). | scoring-methodology §10 calibration gates. | — |

**Total to actionable-but-off (P0–P2): ~4 days. To validated & promotable (P0–P4): ~7 days.**

---

## 11. Acceptance tests

- Same universe snapshot + same genome → byte-stable `rank_pct`, `rank_quality`, and entry decisions.
- ETFs never share a comparable group with single-name equities; an ETF-only group with < min sample is `degraded`, never a fabricated percentile.
- A comparable group with < min eligible names uses the pre-registered fixed transform and is flagged `degraded` — the "three finalists are not a universe" test.
- Thin-evidence, abstained, low-confidence, and held symbols are **excluded** from the ranking pool (row written with `rank_eligible=false`, `rank_pct=null`).
- With `rank_pct_min = 0.0`, selection is **identical** to pre-feature behavior (regression).
- With `rank_pct_min > 0`, the actionable set is always a **subset** of the absolute-floor survivors (never larger).
- Held-position SELL/exit signals are unaffected by any `rank_pct_min` value.
- Within one comparable group, ordering by `rank_pct` equals ordering by `analyst_score`.
- Validation replay of a `rank_pct_min` challenger reproduces the live Pass-2 decisions on the same PIT day (shared function).
- No regime table is read anywhere in the rank path.

---

## 12. Risks & open questions

1. **Small daily universe (biggest risk).** Realistic per-market daily eligible counts (~6 screener + watchlist + a few holdings) are **below** the min-sample thresholds, so most runs use the degraded fixed-transform path — meaning true cross-sectional rank rarely engages until the PIT universe widens. *Mitigation:* the degraded path is honest (collapses to a softened absolute gate); the feature's payoff scales with universe breadth work already on the scoring-methodology roadmap. **Open question:** should we widen the daily screener pull (currently `RESEARCH_SCREENER_MAX=6`) specifically to feed ranking? That trades against the ≤3-candidate/overtrading rule — the pull can widen for *ranking universe* while the *actionable* cap stays ≤3. Needs owner decision.
2. **Sector attribution quality.** Grouping by `OVERVIEW.Sector` depends on that field being populated; missing sector → falls to the market×asset-type group. Acceptable but coarsens groups. India sector coverage is thinner still.
3. **Two-pass latency.** Pass 2 runs inside the 150s cron `maxDuration` after scoring. It is a pure in-memory computation over already-fetched results + a couple of writes — negligible, but must not re-fetch anything.
4. **Interaction with `RESEARCH_CANDIDATE_CAP`.** `gatherSymbols` already caps the candidate map at 10 before scoring; ranking operates on whatever scored, so the cap upstream still governs how many names *reach* the pool. Confirm this ordering is intended (rank ranks the post-cap survivors).
5. **`analyst_score` monotonicity assumption.** The "ordering preserved within group" claim holds because `rank_pct` is the empirical percentile of `analyst_score` within the group. If a future `deterministic_v2` ranks on a `rankScore` distinct from `analyst_score`, revisit the PaperTrader ordering note (§5).
6. **Degraded-rank live eligibility.** Should a `degraded` rank ever be allowed to authorize an autonomous-live order? Recommend **no** — degraded rank is paper/shadow-only evidence; live auto keeps requiring `evidence_confidence` and `live_approved` regardless. Confirm.

---

## 13. What this does NOT do

- Does **not** add or read any market-regime / bull-bear detection (CLAUDE.md locked).
- Does **not** change the dual-bucket screener, its criteria, or its candidate count.
- Does **not** raise the ≤3 actionable candidates/day cap or any position/cash cap — it can only tighten.
- Does **not** remove or alter SELL-for-holdings; the exit path is untouched.
- Does **not** feed rank into the live P(win)/sizing model (logged as a feature only, IC-gated — §6).
- Does **not** let an LLM produce rank, score, direction, or eligibility.
- Does **not** rewrite append-only `decision_observations` rows (rank lives in `universe_snapshot_scores`).
- Does **not** change any live behavior on ship — default `rank_pct_min = 0.0` reproduces today exactly until a validated challenger is owner-promoted.
- Does **not** relabel the scorer `deterministic_v2` (scoring-methodology §1); this is an additive gate on `deterministic_v1`.
```
