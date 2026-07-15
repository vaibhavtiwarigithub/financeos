# External-Repo Shadow Benchmark Track — FEATURE ARCHITECTURE

> Status: **Draft / not approved / implementation not allowed.** Design only.
> Last updated: 2026-07-15.
> Per-market applicability: **both** (US + India), but a given external repo may support only one market — record per-repo coverage; never let a US-only repo emit India advice.
> Update this file when: the sandbox host, snapshot contract, or money-path boundary changes.
> Companion: `features/external-research-integrations/` (the repo capability catalog + intake gate). This doc is the *runtime* shape of using them as a shadow track.

## 1. Purpose

Let vetted external GitHub quant repos run as a **shadow benchmark**: given a frozen data snapshot, each repo records what it *would* decide; Kairos compares that to its own decisions and, over time, learns a **testable hypothesis** ("repo R beats us on regime X / sector Y") — without the repo ever touching data provenance, quotas, or the money path.

This is the concrete answer to "can the GitHub repos be a parallel track now?" — yes, as a **record-only** benchmark. It does **not** require the Router *cutover*; it requires two buildable pieces: a **compute sandbox** and a **snapshot feed**.

## 2. Correcting the earlier over-caution

Two clarifications from discussion:
- A repo that brings **its own data access** (own keys/sources) does **not** blow Kairos's free-tier budgets — and its independent data is a *benefit* (a real second opinion, not an echo of our signals). Budget risk only exists if *we* feed it from our providers.
- The only true blockers are **(a)** running untrusted code safely and **(b)** never letting it influence money before it's benchmarked + governed. Neither is a "danger wall"; both are buildable.

## 3. Non-negotiable boundaries
- **No money influence in P0–P2.** Output is record-only benchmark data. A repo's buy/sell never becomes an order, score, size, or candidate priority.
- **Isolated compute only.** External code runs in **GitHub Actions `--network none`** (or an equally isolated free runner) — never on Vercel, never on the money box, never on a local Windows machine (free-cloud-only + isolation).
- **One-way data.** If Kairos feeds a snapshot, it is a **frozen `EvidenceEnvelope` export** (read-only, point-in-time); the repo cannot call our providers, brokers, or DB. Repos that self-source data get no Kairos data at all.
- **Schema-validated advisory artifact.** A repo returns exactly one typed artifact (its decision + rationale + as-of); malformed/oversized/timed-out ⇒ discarded, logged, no partial trust.
- **Per-market, per-repo coverage.** Record which markets a repo supports; a US-only repo never emits India advice.
- **Benchmark before belief.** A repo's advice is scored the same way any candidate is — forward-return labels via `decision_observations × observation_labels`, per market, after costs, multiple-testing corrected — before it earns any weight, and only via governed Champion/Challenger.
- **Clean-room + license.** Per the existing intake gate: record commit + license, source-review, no copied money-path code.

## 4. Architecture (request → artifact)

```text
Kairos scheduler
  → (optional) export frozen snapshot for symbol set  →  isolated GH-Actions job (repo R, --network none)
                                                          → R runs on its own or the snapshot data
                                                          → emits ONE schema-validated advisory artifact
  ← ingest artifact → store in a benchmark ledger (append-only) → EdgeIC vs Kairos's own decision
```

- **Sandbox host**: GH-Actions workflow per repo, pinned commit, `--network none`, quota-bounded (no paid overage), trusted wrapper that only reads the snapshot + writes the artifact.
- **Snapshot feed**: reuse the Router's `evidence_cache_v2` to export a frozen envelope (only for repos that need our data; self-sourcing repos skip this).
- **Benchmark ledger**: append-only table `external_advice` (repo, commit, market, symbol, as_of, decision, rationale_ref, artifact_hash) — provenance-bound, RLS-on, service-role write.
- **Evaluation**: register each repo as a measure-only `edge_*` source; EdgeIC tracks whether it adds incremental forward-return value over the champion, per market.

## 5. Phases
- **P0**: pick ONE repo from the catalog that self-sources data; run it record-only in the sandbox on the current watchlist; store artifacts; no snapshot feed, no scoring. Prove the sandbox + ingest + benchmark loop.
- **P1**: add the frozen-snapshot export for a repo that needs our data (post-Router-shadow-stability).
- **P2**: benchmark N repos; EdgeIC dashboards ("who beats us where").
- **P3 (governed)**: only a repo that consistently beats the champion out-of-sample, and only via an approved Challenger, may influence candidate discovery — never directly place/size/exit.

## 6. Open decisions (owner / Codex)
1. **First repo**: which catalog repo is the cleanest P0 (self-sourcing, permissive license, one market)? (See `features/external-research-integrations/REPOSITORY_CAPABILITY_CATALOG.md`.)
2. **Snapshot vs self-source default**: prefer self-sourcing repos first (zero budget + data-diversity), add snapshot-fed repos later?
3. **Sequencing vs Router**: P0 (self-sourcing) can start before Router cutover; snapshot-fed (P1) waits for Router shadow-stability. Confirm.
4. **Learning target**: learn a *hypothesis* about the repo's edge (regime/sector conditional), never copy its trades — confirm this framing.
