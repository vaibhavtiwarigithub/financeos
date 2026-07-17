# Risk Analytics — Research Visibility

> Status: **APPROVED — built.** Owner approved 2026-07-17 with §10 decided.
> Author: Claude / Opus 4.8. Date: 2026-07-17.
> Supersedes the approach in `features/risk-research-integration/FEATURE_ARCHITECTURE.md`
> (branch `worktree-agent-abaf0b16ef6af4175`, unmerged) — see §9.
>
> Implementation: `lib/research/risk-annotation.ts` (pure), the `research` block on
> `GET /api/portfolio/risk-daily`, `PortfolioRiskPage.tsx`, and the
> `?symbol=&market=` deep link on the research journal. Tests: `tests/risk-research-annotation.test.ts`.

## 1. What this is

Show, per holding on Risk Analytics: **the research score, its direction, and how old it is** — with a click through to that symbol's research-journal entry. All books: US + India, paper + live.

## 2. What this is NOT — the load-bearing constraint

**Research does NOT enter the risk computation.** Not the score, not the posture, not the action, not the trim allocation. This is a **display join**, nothing more.

Why, restated so a future reader does not "improve" it:
- `lib/risk/holding-risk.ts` has zero research coupling **by design**. `sba-v1` (the water-fill sector-breach allocator, shipped 2026-07-17) is deterministic and research-free.
- A sector is over-cap *because* research liked that sector. Letting `analyst_score` also veto the cap **double-counts the same signal**. The risk layer exists to be the one thing not persuaded by the score.
- The owner integrates the two views. That is where judgment belongs.

**Invariant R1:** no field introduced here may be read by `computeHoldingRisk`, `sba-v1`, `constructPortfolio`, the execution kernel, or any gate. Enforced by test (§7).

## 3. Why the age matters more than the score

This is the actual feature. On 2026-07-16, AVGO was **6 days unscored** while Risk Analytics told the owner to trim it — and nothing on screen said so. A score with no age is how that hid. A 6-day-old 91 and a fresh 91 are not the same claim; today's failure mode was treating them as identical.

Per CLAUDE.md "Detail Over Cryptic": the cell must say what/why/next, never a bare number.

## 4. Staleness — measured in SESSIONS, displayed in DAYS

**Do not measure staleness in calendar days.** Research runs per market on weekdays. A Friday score read on Monday is 3 calendar days old but **1 session** old — measuring in days would paint the whole book stale every Monday and train the owner to ignore the warning.

- **Measure**: market-local *sessions* elapsed since `scored_at` (US and India have different calendars/holidays — `market_controls` / the existing market-local session-date helper is authoritative; do NOT reimplement a weekday count).
- **Display**: "N days ago" (owner's call — plain and readable) **plus** the session-based state.

States:

| State | Rule | Render |
|---|---|---|
| `fresh` | ≤ `STALE_AFTER_SESSIONS` | score + direction, normal |
| `stale` | > `STALE_AFTER_SESSIONS` | **warning** styling + "not scored in N days" |
| `never` | no signal for (symbol, market) | "never scored" — a distinct state, NOT stale |
| `unavailable` | research ran but abstained (thin evidence) | "abstained — thin evidence", NOT a score |

`never` ≠ `stale` ≠ `unavailable`. Collapsing them is the exact bug class this batch removed.

## 5. Data

**Source**: latest `agent_signals` per `(symbol, market)` — `analyst_score`, `direction`, `conviction`, `created_at` (→ `scored_at`), `is_holding`, `market`.

**Join key**: `(symbol, market)`. Never symbol alone — `market` is authoritative; per-market/per-currency never cross-summed.

**Delivery**: extend `GET /api/portfolio/risk-daily` (already returns per-holding rows and is owner-gated) with a nullable `research` block per holding. Additive only — no schema change, no migration.

```
research: {
  score: number | null,
  direction: 'long' | 'neutral' | 'short' | null,
  scored_at: string | null,        // ISO
  sessions_since: number | null,   // market-local
  days_since: number | null,       // display
  state: 'fresh' | 'stale' | 'never' | 'unavailable',
  scored_as_holding: boolean | null,   // see §6
} | null
```

**Two known traps:**
1. **`insider_score = 50` is a default-fill, not evidence.** The honest record is `decision_observations.availability_mask`. Do not surface a dimension as evidence off `agent_signals` alone.
2. **`is_holding` matters.** Before the starvation fix, every AVGO row was `is_holding: false` — scored as a *screener candidate*, not as a holding. That changes meaning: the direction gate can only emit `short` (a deterministic exit) when `isHeld` is true. A `neutral` from a screener-path row does **not** mean "no exit signal". Surface `scored_as_holding` and label it; do not silently present a candidate score as a holding verdict.

## 6. Click-through

Target: `/dashboard/research-journal?symbol=<SYM>&market=<us|india>` → auto-expand that symbol's entry.

**Gap**: `app/dashboard/research-journal/page.tsx` currently expands via local `toggle(symbol)` state and reads **no** `searchParams`. Deep-linking must be added there. Small, but it is net-new surface, not a wire-up.

**Rules**: `never`-state symbols are not links (a link to nothing is a lie). The link must carry `market` — `.NS` symbols are unambiguous but US/India books must not cross-link.

## 7. Acceptance tests — each must be able to FAIL

| # | Test |
|---|---|
| T1 | **R1**: `computeHoldingRisk` / `sba-v1` output is byte-identical with the `research` block present vs absent. (Falsifiable: wire the score in → T1 fails.) |
| T2 | A score older than `STALE_AFTER_SESSIONS` renders `stale` + day count; one inside renders `fresh`. |
| T3 | **Friday score, read Monday, threshold = 1 session → `fresh`.** (Falsifiable: a calendar-day implementation fails this.) |
| T4 | No signal → `never`, not `stale`, not score 0, and **not a link**. |
| T5 | An abstained (thin-evidence) signal → `unavailable`, never rendered as a number. |
| T6 | US and India books never cross-join: an India `.NS` symbol resolves only against `market='india'` rows. |
| T7 | A `is_holding:false` row is labelled as a candidate score, not a holding verdict. |
| T8 | The risk API still returns holdings when `agent_signals` is empty/errors — research absence must never blank the risk table (fail-soft, per §8). |

## 8. Failure modes

| Mode | Behavior |
|---|---|
| `agent_signals` read fails | Risk table still renders; research column shows an explicit "research unavailable" — **never** silently blank, never a fake score. Fail-soft: risk is the primary product here, research is the annotation. |
| Research hasn't run today | Correct and expected → `stale` with the day count. This is the feature working. |
| Symbol held in 2 accounts | One research row per (symbol, market); it is a property of the symbol, not the account. Same annotation both places. |
| India research abstains (sentiment 0% available) | `unavailable`, not a score. |

## 9. Relationship to the earlier proposal

`features/risk-research-integration/FEATURE_ARCHITECTURE.md` proposed research **ordering** which names absorb a sector trim. **Not pursued.** Its central premise — that AVGO's 80 was `thinEvidence` — is factually wrong (AVGO carries all 5 dimensions; the `neutral` came from a since-changed thesis-parse-abstain path). It also could not resolve whether conviction-ordering smuggles the score back into a risk decision, and the only-diversifier objection stands. **This spec is the cheaper, safer half: show both, couple neither.**

## 10. Owner decisions — DECIDED 2026-07-17

All four are settled. This section is a record, not an open question.

| # | Decision | **DECIDED** | Rationale as approved |
|---|---|---|---|
| Q1 | `STALE_AFTER_SESSIONS` | **2** | The merged holdings rotation bounds worst-case staleness at ~2 runs, so `1` would flag ordinary rotation lag as a warning (noise) and train the owner to ignore it. `2` flags only genuine starvation — which is what AVGO actually was. |
| Q2 | Does `stale` also mark the row's **risk action** as lower-confidence? | **NO** | `stale` annotates the SCORE only. It must NOT dim or alter the risk action or verdict — that edges toward the coupling this spec exists to refuse. |
| Q3 | Show `conviction` alongside `analyst_score`? | **OMIT** | Identical to `analyst_score` in every prod row inspected. Revisit only if they diverge. |
| Q4 | Mobile (375px) columns | **score + age badge only** | Direction and `scored_as_holding` go behind the existing row expander. Mobile-first is a standing rule. |

**Verified against prod after the decision (2026-07-17, project `dionkikgdmlaotvtbnfr`):**

- **Q3 is right, and for a better reason than stated.** `analyst_score = conviction` in
  **458 of 463** rows — not all of them. The 5 exceptions (AAPL 58/62, NVDA 55/48,
  TSLA 36/58, MSFT 53/52, META 69/68) are all from **2026-06-28** and all carry
  `score_source = null` — the pre-`deterministic_v1` LLM-scored era. **Since
  `deterministic_v1` shipped, the two have never diverged.** So `conviction` is
  redundant *by construction* under current scoring, not merely *empirically*.
  Revisit if a future scorer decouples them.
- **Q1's threshold does what it was chosen to do.** AVGO's latest row (scored
  2026-07-13, read 2026-07-17) is **4 sessions** old → `stale`. The India book
  (scored 2026-07-17 04:00 UTC) is `fresh`. The threshold separates the two.

## 10a. What prod actually looks like (measured, not assumed — 2026-07-17)

Three findings that shape the implementation:

1. **`is_holding` is `false` in 463 of 463 rows — 100%.** Not an AVGO quirk: **no
   holding-path score has ever been written.** Every score on the Risk page is a
   screener-candidate score. §5 trap 2 is therefore the *common* case, and
   `scored_as_holding` is labelled on every row rather than as an edge case.
2. **There is no abstain representation in `agent_signals`.** `analyst_score` is
   non-null in all 463 rows; no column encodes "ran but abstained". The
   `unavailable` state is therefore **defensive, and currently unreachable in
   prod** — it fires only if research ever writes a null/NaN score, so that an
   abstain degrades honestly instead of rendering as `0`. T5 pins it against a
   fixture. **This is the one state with no production witness.**
3. **`never` currently has no production witness either.** Every holding in every
   account's latest run resolves to a signal. The state still exists and is
   tested — a book with a new position would hit it immediately — but it is not
   observable today.

## 10b. Spec corrections found while building

- **§6's premise was wrong.** `app/dashboard/research-journal/page.tsx` *did* read
  `searchParams` (for `tab`), and the `toggle(symbol)` expander described there
  lived in a local `FunnelTab` component that **was never rendered** — dead the day
  it was written. The page has always delegated to `components/dashboard/ResearchFunnel.tsx`.
  Deep-link support therefore went into `ResearchFunnel.tsx`; the dead `FunnelTab`
  was deleted rather than modified, since it was the source of the misreading.
- **The session helper already existed.** `marketSessionsSince(createdAt, now, market)`
  in `lib/trading/paper-exit-policy.ts` (built on `isMarketHoliday` in
  `lib/trading/market-calendar.ts`) is the market-local session authority. Reused,
  not reimplemented, per §4.

## 11. Out of scope
Live-trading accounts the app cannot trade (e.g. `965848641`) get the same annotation — it is informational there, as the strategy note already is. No new cron, no migration, no provider call, no LLM.
