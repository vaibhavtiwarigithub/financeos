# Relationship Graph & Event Propagation — FEATURE ARCHITECTURE

> Status: **Draft / not approved / implementation not allowed.** Design only.
> Last updated: 2026-07-15.
> Update this file when: the extraction sources, graph schema, propagation logic, or money-path boundary change.

## 1. Problem

Stocks are a tightly/loosely woven net. A company's disclosure moves related names:
- **Company X announces a partnership/contract/supplier deal with Y** → Y's stock tends up (new revenue/validation).
- **X drops Z for Y** → Z tends down (lost the anchor customer).
- Suppliers, customers, JV partners, and competitors all propagate second-order moves off one company's news/filings.

Kairos today detects **none** of this. What exists is adjacent, not this:
- `lib/risk/correlation.ts` — backward-looking **price-return** correlation among *held* names, for portfolio-risk cluster detection only.
- `symbol_profiles.peers` — Finnhub `company-peers` (similar/competitor names), **context-only, not scored, not propagated**.
- News/sentiment — GDELT **per-symbol tone**, no entity-relationship extraction.

This feature adds an explicit **signed company-relationship graph** plus an **event-propagation engine** that turns one company's material news into directional attention/candidate signals on its neighbors.

## 2. Hard boundaries (non-negotiable)

- **No LLM on the money path.** The LLM does *relationship extraction* and *idea generation* only (off the money path). A propagated neighbor becomes a normal research candidate and is scored by the existing **deterministic** engine + gated by the existing gates. The graph never sets a score, size, or order.
- **Attention/candidate, never auto-trade.** Propagation surfaces a candidate + a rationale ("Y is X's newly named supplier; X's 8-K on 2026-07-14"). It does not open, size, or exit anything on its own.
- **Long-only for new positions** stays. A "displaced competitor Z trends down" edge is *information* — it can (a) suppress/deprioritize a long candidate, or (b) feed the separate governed **downside-hedge**/inverse path, never place a short.
- **Provenance-bound.** Every edge cites its source disclosure (filing accession / news id + date). No edge without a citation. Edges decay with age.
- **Free-cloud-only.** Extraction runs in the research/cron tier or the future GH-Actions sandbox; no paid supply-chain vendor.

## 3. Data sources (free)

| Relationship signal | Source | Notes |
|---|---|---|
| Partner/supplier/customer mentions | SEC EDGAR 8-K / 10-Q / 10-Q segments; FinancialDatasets filings + `segmented_financials` | richest + most reliable; material events are 8-K |
| Competitor set | Finnhub `company-peers` (already fetched into `symbol_profiles.peers`) | seeds the "competitor" edge type |
| Co-mention / news linkage | GDELT + FinancialDatasets news | weaker, higher-recall; directional tone |
| Institutional overlap (optional, later) | 13F holder overlap | "smart-money co-ownership" edges |

## 4. Graph schema (proposed)

`company_relationships` (append-only, provenance-bound):
| col | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `source_symbol` | text | the company making the disclosure (X) |
| `target_symbol` | text | the related company (Y/Z) |
| `relation` | text | `partner` \| `supplier` \| `customer` \| `competitor` \| `jv` \| `displaced` |
| `direction` | int | +1 (bullish for target) / −1 (bearish for target) / 0 (neutral link) |
| `weight` | numeric | 0–1 confidence from extraction |
| `evidence_ref` | jsonb | `{source:'edgar', accession, filed_date}` or `{source:'news', id, published}` — **required** |
| `market` | text | us \| india (never cross-market propagation without an explicit cross-listing edge) |
| `first_seen` / `last_seen` | timestamptz | recency; edges decay |
| `created_at` | timestamptz | |

RLS: `authenticated`-read, service_role write (matches the security pattern). Append-only trigger (never mutate an edge; supersede with a newer row).

## 5. Pipeline

1. **Extract** (LLM, off money path, in research cron or sandbox): for each covered company's new 8-K/10-Q/material news, prompt an LLM to emit `{target, relation, direction, weight, evidence_ref}` tuples — strict JSON, fail-closed (no tuple without a citation). Store in `company_relationships`.
2. **Graph build**: deterministic assembly of the current signed graph (latest non-superseded edge per (source,target,relation), decayed by age).
3. **Propagate**: when `source_symbol` has a **material event today** (big price move OR a fresh 8-K), walk 1 hop to neighbors. For each neighbor: emit a *candidate* with `discovery_source='relationship_graph'`, a rationale, and the edge citation. Bounded fan-out (top-K by weight × direction × recency).
4. **Score**: the neighbor candidate enters the **normal** deterministic research/scoring path (research-agent). The graph contributed *why it's a candidate*, not the score.
5. **Learn**: forward-return labels on graph-sourced candidates (via `decision_observations`/`observation_labels`) → measure whether relationship-propagation actually has edge, per relation type, before it earns any weight. Gated like every other dimension (10+/20+ matured).

## 6. Phased rollout

- **P0 (shipped separately): peer-move attention MVP** — no graph; reuses `symbol_profiles.peers` + one grouped-daily price call to flag "a related name to your holding moved X% today". Attention-only.
- **P1: read-only graph from cheap edges** — seed `competitor` edges from existing peers; add `co-mention` edges from news. Display the neighborhood on the symbol page. No propagation into candidates yet.
- **P2: LLM extraction from filings** — 8-K/10-Q → `partner/supplier/customer/displaced` edges with citations. Still display-only.
- **P3: propagation into candidates** — graph emits `discovery_source='relationship_graph'` candidates into the deterministic scorer; measured, not trusted.
- **P4: earns weight / feeds downside path** — only after P3 shows real forward-return edge per relation type; `displaced`/bearish edges may feed the governed inverse-ETF hedge, never a short.

## 7. Open decisions (for owner / Codex)

1. **Extraction host**: research cron (simplest, spends LLM budget) vs the future GH-Actions sandbox (isolated, aligns with external-repo work). Recommend: start in cron at low volume (covered names only), move to sandbox at scale.
2. **Cross-market edges**: keep US and India graphs fully separate (recommended) vs allow explicit cross-listing/ADR edges (e.g. an Indian supplier to a US name). Default: separate; cross edges are a later, explicit opt-in.
3. **Displaced/bearish edges**: suppress-a-long only, vs also feed the downside-hedge path. Recommend suppress-only until the hedge itself is proven.
4. **This overlaps** the `external-research-integrations` work (some repos do knowledge-graph analysis) and `graphify`. Decide whether to build native or adopt a repo's extractor as a sandboxed worker.

## 8. Why not now

Phase 0, tiny sample, free-tier, and this is a big LLM-dependent build. The **P0 peer-move MVP** delivers the intuition cheaply today; the full graph is real research edge but should follow the Canonical Evidence Router (for the data snapshot the extractor consumes) and the sandbox (for isolated compute). Captured here so the design is ready when sequencing allows.
