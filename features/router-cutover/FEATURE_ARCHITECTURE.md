# Canonical Evidence Router — Phase-4 Cutover & Eligibility-Flip Guard

> Status: **Draft / not approved / implementation not allowed.** Design only — this is the *plan* to flip `router_enabled`, gated on shadow-parity evidence.
> Last updated: 2026-07-15.
> Per-market applicability: **both**, but cutover is **per-market and independent** — US may cut over before India (or vice-versa); never flip both at once.
> Companion: `features/data-source-policy/FEATURE_ARCHITECTURE.md` (the Router itself, shadow-only today).
> Update this file when: the cutover criteria, the eligibility-flip guard, or the rollback plan change.

## 1. Where we are

The Canonical Evidence Router is built and running **shadow-only** (`router_enabled=false` for US and India, verified in prod). The resolver is fail-closed and only the shadow route may exercise a disabled policy. Nothing on the scoring/order/money path reads router output yet.

Cutover = feeding the resolver's `EvidenceEnvelope` into the deterministic scorer for a market, replacing the legacy AV-first fetch path — **only after** shadow data proves the router returns the same-or-better evidence the legacy path did, with no new failure mode.

## 2. Gate: what must be true before flipping `router_enabled` (per market)

1. **Shadow parity, N days.** Over ≥ a defined window (e.g. 10 trading days), the router's resolved fields match the legacy path within tolerance for the covered universe; divergences are explained (better freshness / added source), never silent losses.
2. **Coverage floor.** Each required intent (price/fundamentals/analyst/…) meets a per-market coverage % on the live universe (no regressions vs legacy).
3. **The eligibility-flip guard is in place** (see §3).
4. **Provenance integrity.** Bars/insider/etc. record the REAL serving source; no fabricated neutral values; ledger has no secrets.
5. **Rollback proven.** Flipping `router_enabled=false` instantly restores the legacy path with no state corruption (idempotent, no half-migrated scores).

## 3. The eligibility-flip guard (the key safety piece)

**Risk:** scoring renormalizes weights across *available* dimensions. If a dimension drops out — because a policy change OR a provider outage removed it — renormalization can push a symbol from **ineligible → eligible** (or change its rank) purely from *missing data*, not new information. Under the router this can happen from a routing change, which is unacceptable on the money path.

**Guard (deterministic, scoring-boundary check):**
- Compute the score both **with** and **without** the dimension that changed availability; if removing/adding a dimension would flip eligibility across the entry threshold, **hold at the more conservative outcome** (never let a *data-availability* change alone create a new long).
- A symbol may only become newly eligible when a **real evidence change** (not a routing/availability change) crosses the threshold.
- Missing/збnewly-unavailable dimension ⇒ treat as `unavailable` + renormalize *only within a documented floor*; below the floor, abstain (matches the existing thin-evidence abstain rule).
- Log every guard trigger to System Health so a routing change that would have flipped eligibility is visible.

This guard must exist and be tested **before** cutover, and it protects the legacy path too.

## 4. Cutover procedure (per market, reversible)
1. Confirm §2 gate green for that market (shadow-parity report + coverage + guard tests).
2. Split the multi-source Massive candle adapter into explicit Router adapters (Codex-flagged pre-cutover item) so provenance is per-source, not nominal.
3. Flip `router_enabled=true` for **one** market via the governed policy activation RPC (immutable version + active pointer).
4. Run in production with the legacy path computed **in parallel (shadow-reverse)** for M days — now the *legacy* is the shadow — alerting on any divergence.
5. If clean, retire the legacy fetch for that market (Phase-5 cleanup). If not, flip back (instant rollback) and diagnose.
6. Repeat independently for the second market.

## 5. Boundaries
- Deterministic — the router changes *where evidence comes from*, never *how it's scored*; no LLM introduced on the money path.
- Per-market independent; currency never cross-summed; one market at a time.
- Fail-closed — any gate ambiguity blocks cutover; the resolver already fails closed on missing policy/data.
- Reversible — `router_enabled` is a per-market switch with proven instant rollback.

## 6. Open decisions (owner / Codex)
1. **Parity window + tolerance**: how many shadow days and what field-level tolerance define "parity"? (Balance rigor vs time-to-value.)
2. **Coverage floor per intent per market**: exact %s, especially for India where some sources are structurally sparse.
3. **Eligibility-flip guard placement**: at the resolver boundary, the scorer boundary, or both (defense-in-depth)? Recommend both.
4. **Order of markets**: cut US over first (richer data) then India, or gate India longer given sparser sources?
