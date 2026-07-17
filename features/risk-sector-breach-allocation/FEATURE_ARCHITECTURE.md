# Feature: Sector-Cap Breach Allocation (risk-internal, deterministic)

**Status:** BUILT — branch `worktree-agent-a6596ea918d82369a`, not merged
**Last updated:** 2026-07-16
**Owner:** Vaibhav
**Update this file when:** the allocation rule, its denominator basis, the breach
arithmetic, the roles (`absorb` / `not_selected` / `no_breach` / `sector_unknown`),
or the read-only advisory labelling changes.

**Parent feature:** `features/holding-risk-daily/FEATURE_ARCHITECTURE.md` — this file
is the authority for the allocator; that file remains the authority for the score,
the cron, the snapshot schema, and the LLM prose boundary.

---

## 1. The defect this exists to fix

Risk Analytics shipped this for AVGO, a live holding in the read-only Robinhood
account `965848641`:

> "Strategy note (advisory): Trim your position because Technology holdings exceed
> the 30% sector cap (at 65.6%), with a risk score of 63..."

**A sector-cap breach is a property of the SECTOR, not of any one name.** In
`lib/risk/holding-risk.ts` (`hr-v1`) the posture branch read:

```ts
const sectorBreach = sectorUtil !== null && sectorUtil >= 1;
if (nameBreach || sectorBreach || clusterBreach) { riskPosture = "trim"; ... }
```

`sectorUtil` is the same number for every holding in the sector. So **every**
Technology name received the identical `trim` verdict, with identical prose, and
the engine never decided **which** names should absorb the breach or **how much**
each gives up. The advice is arbitrary (no name is distinguished) and
unactionable (no quantity). Trimming all six Tech names by an unstated amount is
not a plan.

Note the same run also emitted `trim` for AVGO while ResearchAgent had not scored
AVGO since 07-13 (see WORK_LOG, holdings-starvation entry). That is a separate
bug; it is **not** evidence that risk should read research scores. See §7.

## 2. What this builds

`lib/risk/sector-breach.ts` — a pure, versioned (`sba-v1`) allocator:

> Given a sector that is over its cap and the reduction required to reach the cap,
> decide **which** holdings absorb it and **how much** each gives up.

Deterministic. No LLM. No research score. No I/O, no clock, no randomness — same
inputs always yield the same allocation. It is called by the holding-risk cron
before `computeHoldingRisk`, and its per-name result is threaded into
`HoldingRiskContext.sectorBreachAllocation`.

## 3. Denominator: NAV, and why it decides the arithmetic

The breach amount is **not** basis-independent. Let `S` = sector market value,
`D` = the denominator the cap is measured against, `c` = cap fraction:

| Denominator | Does a sale change `D`? | Value that must be sold |
|---|---|---|
| **NAV** (cash-inclusive) | No — proceeds become cash, still inside `D` | `X = S − c·D` |
| **Invested** (cash-excluded) | Yes — proceeds leave `D` | `X = (S − c·D) / (1 − c)` |

At Tech 65.6% / cap 30%: NAV basis → sell **35.6pp**. Invested basis → sell
**50.9pp**. Picking the wrong basis makes the advice wrong by ~43%.

**Kairos' sector cap is NAV-relative.** `lib/risk/live-portfolio-gate.ts` — the
code that actually enforces `max_sector_exposure_pct` on the live money path —
builds the book as `valuePct = position value / NAV × 100`. That is the
authoritative reading of the owner's limit. `lib/risk/holding-risk.ts` already
scores **name** concentration against `accountTotalValue` (NAV) for the same
reason.

So the allocator takes `navValue` (not a generic "denominator"), and the required
reduction is the simple `X = S − c·D`. The field is named `navValue` precisely so
a future caller cannot silently feed an invested-total and get 43%-wrong advice.

### 3.1 Known inconsistency this fixes (and one it does not)

`hr-v1` fed `sectorWeightPct` from `computeRiskMetrics().sectorBreakdown`, whose
`weightPct` is **invested-relative** (`lib/portfolio-risk.ts` L307–318:
`totalValue = holdings.reduce(...marketValue)`). So `hr-v1` compared name
concentration against NAV and sector concentration against invested — two
different denominators against two caps the owner set on one basis. The cron now
derives sector weights on the NAV basis from the allocator, so the sector driver
and the allocation agree, and both agree with the name driver.

**Not fixed here (deliberate):** `computeRiskMetrics().sectorBreakdown` remains
invested-relative for the account roll-up display. Changing it touches the paper
path, `constructPortfolio` inputs, and the Risk page's sector bars — out of scope
for a risk-verdict fix. The two numbers can differ for a cash-heavy account.
Recorded as a follow-up.

## 4. The allocation rule — WATER-FILL (level-down, largest-first)

**Rule.** Trim the largest positions in the breached sector down to a single
common level `L`, chosen so the sector lands exactly on the cap:

> find `L` such that `Σ min(wᵢ, L) = c` over the sector's names (weights as
> fractions of NAV), then `trimᵢ = max(0, wᵢ − L)`.

Names with `wᵢ ≤ L` are **not touched**. Names with `wᵢ > L` absorb the breach,
largest first, and all end at the same weight `L`.

Solved in closed form: sort weights ascending, and for `k = 0..n−1` test the
candidate `L = (c − prefix[k]) / (n − k)`, accepting the first `k` where
`L ≥ w[k−1]` and `L ≤ w[k]`. `Σ min(wᵢ, L)` is continuous and non-decreasing in
`L`, from `0` to the sector weight, so exactly one `L` exists whenever
`0 < c < sectorWeight`.

### 4.1 Justification

**Why not pro-rata?** Scale every name in the sector by `c / sectorWeight`.
- *For:* expresses no view on which name is worse — appropriate, since a risk
  engine with no conviction input has no such view.
- *Against, decisive:* **every** name is trimmed, so every name still gets the
  same blanket "trim" verdict — the exact defect in §1, re-shipped with numbers
  attached. And it preserves the sector's concentration profile: after a
  pro-rata cut the book is at the cap but just as lopsided, so the *name* cap —
  a second limit the owner set — is left as breached as it was. Rejected.

**Why not "highest marginal contribution to the breach" first?** For a *sector
weight* cap, a name's marginal contribution to the sector weight **is its
weight** — `∂(Σwᵢ)/∂wⱼ = 1`. So this rule is identical to largest-first with an
extra abstraction that invites smuggling correlation or beta into the ordering.
Those are separate risk components with their own caps and their own missing-data
paths; folding them into the sector allocation would make one number's absence
silently reshuffle who sells. Rejected as a distinct rule.

**Why water-fill wins.** Among all allocations that reach the cap **by reducing
only** (`0 ≤ tᵢ ≤ wᵢ`), the water-fill is the one that minimises the largest
residual name weight `max wᵢ′` — and, more generally, minimises `Σ (wᵢ′)²` (the
sector's Herfindahl). Sketch: any feasible allocation with two names at
`a > b ≥ L` where the water-fill would have levelled both must have `max wᵢ′ ≥ a > L`;
levelling weakly reduces both the max and the sum of squares while holding the
total fixed. So the water-fill discharges the sector breach **and** does the most
it can for the name-concentration cap at the same time — the two limits the owner
actually set point the same way. It also yields real "hold" verdicts for small
names, which is what makes the output actionable rather than a blanket.

**Honest cost.** Water-fill sells your biggest name first, which is often your
best name. The risk engine cannot know that — it has no conviction input **by
design** (§7). Absent a view, a same-sector shock hits every name in the sector
and expected loss scales with weight, so reducing the largest exposures is the
risk-correct action. If the owner wants conviction to reorder who sells, that is
a Research↔Risk coupling decision, not a change to this allocator.

### 4.2 Determinism and tiebreaks

- **Ties in weight need no arbitrary winner.** Water-fill is a continuous
  function of the weight vector: two names at identical weight receive identical
  trims by construction. There is no "first one wins" step that a tie could turn
  arbitrary. *(Test: `equal weights receive equal trims`.)*
- **Comparison tolerance.** The fill runs in weight-fraction space (values ~0–1),
  not currency, so a fixed `EPS = 1e-12` is meaningful at every account size.
- **Output ordering** (the only place a tiebreak is needed): absorbers are
  ordered by `trimPct` descending, then `symbol` ascending (lexicographic).
  `rank` follows that order. Sector summaries are ordered by
  `sectorWeightPct` descending, then `sector` ascending.
- **No materiality floor.** A name is `absorb` iff its trim is `> 0`. A floor
  would have to redistribute the dropped remainder, which reintroduces an
  arbitrary choice for a cosmetic gain.

### 4.3 Degenerate inputs

| Input | Behavior |
|---|---|
| `navValue` ≤ 0 / non-finite | Empty result; every symbol `sector_unknown`-style honest reason is **not** used — the caller's structural gate already returns `insufficient_data` first. |
| `maxSectorExposurePct` ≤ 0 or ≥ 100 | Cap unusable → sector reported `no_breach` with the cap echoed; never a fabricated breach. |
| Sector weight ≤ cap | `no_breach` for every name in it; `requiredReductionPct = 0`. |
| Non-finite / negative `marketValue` | That position is excluded from its sector's total and reported as `sector_unknown` (unvalued), never counted as 0. |

## 5. Per-name output (Detail Over Cryptic)

`SectorBreachAllocation` per symbol, with a `role`:

| Role | When | `action_reason` says |
|---|---|---|
| `absorb` | breached sector, `wᵢ > L` | *what*: trim N pp of NAV, to X% (≈ value in account currency). *why*: sector is P% vs the C% cap → Rpp must come out; this is the #k of n largest names, allocated largest-first down to a common L% level. *next*: advisory suffix. |
| `not_selected` | breached sector, `wᵢ ≤ L` | *what*: hold. *why*: "**Technology is over its 30% cap (65.6% of NAV) and 35.6pp must come out, but AVGO is not among the names selected to absorb it** — at 3.6% of NAV it already sits at or below the 5.4% level the 4 larger Technology positions are being trimmed to." *next*: what would change the verdict. |
| `no_breach` | sector within cap | sector weight vs cap, no reduction required. |
| `sector_unknown` | sector null/empty/"Other", or unvalued | "sector unknown — excluded from sector-cap allocation: neither counted toward a breach nor asked to absorb one." Never treated as its own sector, never as cap-compliant. |

## 6. Posture wiring (`lib/risk/holding-risk.ts`, `hr-v1` → `hr-v2`)

Two new **optional** `HoldingRiskContext` fields:
`sectorBreachAllocation?: SectorBreachAllocation | null`, `readOnlyAccount?: boolean`.
Everything else — the score, the six components, the caps, the confidence
weights, `add_capacity` — is unchanged. Scores do not move except through the
NAV-basis denominator correction in §3.1.

Precedence (the exit branch is untouched and stays first):

1. verified protective-stop / thesis-break → `exit_review` — **unconditionally**,
   regardless of any allocation. Drawdown alone still never triggers it.
2. `nameBreach || sectorSelected || clusterBreach` → `trim`, where
   `sectorSelected = sectorBreach && allocation.role === "absorb"`.
   **A sector breach on its own is no longer a trim trigger for a name the
   allocator did not select.**
3. `sectorBreach` **and no usable allocation** → `review` +
   `missing_inputs: ["sector_breach_allocation"]`. Reason: the sector is over cap
   but the engine cannot say whether *this* name should absorb it.
4. `dataConfidence < 0.5` → `review` (unchanged).
5. otherwise → `hold`; when `role === "not_selected"` the hold carries the
   allocator's why-not sentence instead of "within owner-approved risk limits"
   (which would be a lie while the sector is over cap).

**Default-to-honest, never default-to-confident.** Case 3 is the
`degradation-guard` discipline: a legacy caller that supplies no allocation gets
`review` — the *old* blanket-trim behavior is not preserved as a fallback,
because a fallback to the bug is the bug.

`formula_version` bumps `hr-v1` → `hr-v2`: the posture semantics changed, and
`risk-daily` must not diff a v2 posture against a v1 posture. No migration —
`formula_version` is `text`, `risk_posture` keeps its existing CHECK values, and
the allocation surfaces in the existing `action_reason` (text) and the sector
driver's `detail` (jsonb).

## 7. Explicitly out of scope

- **No `analyst_score` / `agent_signals` / conviction coupling.** The entire point
  is that this needs **zero** Risk↔Research coupling: the allocator is a function
  of weights and one owner-set cap. The competing proposal
  (`features/risk-research-integration/FEATURE_ARCHITECTURE.md`, branch
  `worktree-agent-abaf0b16ef6af4175`, unmerged) is untouched.
- **No order path.** The route places, previews, and cancels nothing. Only
  `605420660` may ever place an order, and only via the owner-click Execution
  Gateway, which this feature does not call.
- **No LLM on any number.** The LLM still writes `strategy_note` prose only, and
  is now handed the allocation as read-only context it must explain, never alter.
  `lib/risk/strategy-notes.ts` extracts the parse step so this is provable:
  `parseStrategyNotes()` returns `Map<symbol, string>` and **cannot** express a
  score, a posture, a trim, or a symbol that was not asked for.
- No migration. No schema change.

## 8. Advisory labelling

`readOnlyAccount` is set by the cron: `false` only for `605420660` (the sole
order-permitted account per CLAUDE.md), `true` for every other account including
`965848641` — where AVGO sits. Actionable postures (`trim`, `exit_review`) carry:

- read-only → *"Advisory only — this account is read-only in Kairos; the app cannot trade it."*
- `605420660` → *"Advisory only — this feature places no order; any action requires owner approval in the Execution Gateway."*

Both are advisory. The distinction tells the owner whether an order path exists
at all, rather than implying one does.

## 9. Acceptance tests (falsifiable — each states the implementation that fails it)

`tests/sector-breach.test.ts`, `tests/holding-risk.test.ts`, `tests/strategy-notes.test.ts`.

| # | Test | Fails when |
|---|---|---|
| 1 | Tech 65.6% of NAV vs 30% cap → `requiredReductionPct ≈ 35.6`, and `Σ trimPct ≈ 35.6` | the invested-basis formula (would give 50.9), or an off-by-cap error |
| 2 | Post-trim sector weight equals the cap exactly; every `targetWeightPct = min(wᵢ, L)` | the fill level is mis-solved |
| 3 | Reproducible: two runs over the same input deep-equal; input array shuffled → identical `bySymbol` | any iteration-order or `Map`-order dependence |
| 4 | Two names at identical weight get identical `trimPct`; ordering ties break `symbol` ascending | any "first/last one wins" branch |
| 5 | A small name below `L` gets `role: "not_selected"`, `trimPct === 0`, and a reason naming its sector, the cap, the breach size, and why it was not selected | pro-rata (nothing would be `not_selected`), or a bare "hold" string |
| 6 | Every name in a breached sector gets its own `trimPct`, and **not all are equal** | blanket-trim (`hr-v1`) — all names identical |
| 7 | `protectiveStopHit` + `role: "not_selected"` → still `exit_review` | the allocator being consulted before the exit branch |
| 8 | `thesisBreak` + `role: "not_selected"` → still `exit_review` | same |
| 9 | Sector breached, **no** allocation supplied → `review`, `missing_inputs` contains `sector_breach_allocation`, posture is **not** `trim` | a fallback to blanket-trim |
| 10 | Sector breached, `role: "absorb"` → `trim`, reason carries the pp figure | allocation ignored |
| 11 | Sector breached, `role: "not_selected"`, nothing else breached → `hold` **and** reason is not "within owner-approved risk limits" | the generic hold string leaking while the sector is over cap |
| 12 | Name breach + `role: "not_selected"` → still `trim` (name cap) | the allocator suppressing a *different* limit's breach |
| 13 | Cluster breach + `role: "not_selected"` → still `trim` | same |
| 14 | India: INR account, `.NS` symbols, India sector labels → identical allocation shape; `no_breach` when within cap | any US-GICS or USD assumption |
| 15 | US and India inputs with equal weights produce equal `trimPct` and never a summed/cross-market total | cross-market contamination |
| 16 | `sector: null` / `"Other"` / `""` → `role: "sector_unknown"`, excluded from every sector total, reason says "sector unknown"; the other names' allocation is unchanged by its presence | bucketing unknowns into a synthetic sector (what `constructPortfolio` does), or treating them as cap-compliant |
| 17 | A sector that is entirely unknown-sector names produces **no** `no_breach` claim for them | silent cap-compliance |
| 18 | `parseStrategyNotes` given `{"AVGO":{"trim_pct":99},"risk_posture":"hold","ZZZZ":"x"}` returns **no** AVGO note, no `risk_posture` key, no `ZZZZ` | any parser that passes non-strings or unrequested keys through |
| 19 | `parseStrategyNotes` over unparseable/absent LLM text → empty map, never throws | prose failure blocking a deterministic row |
| 20 | Read-only account → `trim`/`exit_review` reason states the account cannot be traded | missing advisory labelling |
| 21 | `navValue` unchanged, cap 0/100/NaN → `no_breach`, never a fabricated breach | an unguarded cap divide |

Plus the parent feature's existing `hr` suite (structural gate, component caps,
loss-only-never-exit, purity) must stay green.

## 10. Cross-doc updates shipped with this

- `docs/arch/08-risk-and-safety.md` — "Daily Per-Holding Risk Analytics" section.
- `features/holding-risk-daily/FEATURE_ARCHITECTURE.md` — pointer to this file.
- `WORK_LOG.md` — entry.
- `public/agent-diagrams/system-map.json` — the **diagram is unchanged**: no
  agent-to-agent flow, handoff, table dependency, schedule, or learning-loop edge
  changed; this is internal to the HoldingRisk node's own compute. But the
  `HOLDINGRISK` node's own `description` asserted `hr-v1` and the old
  "hard concentration/cluster breach -> trim" rule, which is now false — so the
  node description is corrected and a `history` entry appended.
- **No migration.**
