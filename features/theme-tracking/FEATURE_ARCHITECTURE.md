# Theme Tracking — Feature Architecture

Status: **Step 1 approved and shipped 2026-08-04. Steps 2-5 remain proposals.**
Author: Claude · 2026-08-04
Related: `app/api/agents/theme-scout/route.ts`, `features/edge-factor-discovery/`,
`features/india-scorer-discrimination/DIAGNOSIS.md` §14, `R3_DIMENSION_FEASIBILITY.md`.

---

## 1. Correcting the premise

The question was whether the app can tell which themes and sub-themes are rising
or declining. My first answer was that themes are not tracked at all. **That was
wrong** — `watchlist.theme` exists and is written on every Theme Scout row:

```ts
rowsBySymbol.set(clean, { source: "llm_theme", theme: t.theme, ... })
```

182 rows across 13 scout runs, **zero nulls**. The data is there.

The real defect is narrower and more interesting: **the theme has no stable
identity**, so it cannot be counted across runs.

---

## 2. The measured defect — identity drift

182 rows produce **42 distinct theme strings** over 13 runs, and **32 of those 42
appear in exactly one run**. Naive normalisation (lowercase, strip spaces and
hyphens) collapses 42 → 40, so the drift is semantic, not formatting.

Cybersecurity is the clearest case — **six strings, one theme**:

| string | rows | runs | first → last |
|---|---:|---:|---|
| `Cybersecurity` | 18 | 5 | 06-30 → 07-06 |
| `Cyber Security` | 16 | 5 | 06-30 → 07-06 |
| `Cybersecurity Solutions` | 4 | 2 | 07-02 → 07-06 |
| `Cyber Security Boom` | 4 | 2 | 07-01 → 07-02 |
| `Cybersecurity Demand` | 4 | 1 | 06-30 |
| `Cybersecurity Threats` | 2 | 1 | 06-30 |

48 rows over five-plus weeks, which should read as one persistent theme, and
instead reads as six — four of them apparently one-off noise. Same pattern in
`Cloud Computing` / `Cloud Computing Expansion`, `Digital Payments` / `Digital
Payments Growth`, `Renewable Energy` / `Clean Energy`.

The cause is structural: the theme name is free text from an LLM prompt, minted
fresh each run with no vocabulary and no memory of prior runs.

**Consequence:** no rise/decline signal is computable today. "Cybersecurity has
appeared in 5 of the last 13 runs and is strengthening" is a true statement the
data cannot currently express.

### A second finding, surfaced by the same query

The three most recent runs (07-27, 08-03) produced `Autonomous Tech`,
`Debt Reduction`, `Consumer Expansion`, `Grid Safety`, `Defensive Consumer` —
each appearing exactly once, and several of which are not investable themes but
generic observations. The recurring themes (`Cloud Computing`, `Cybersecurity`,
`Renewable Energy`) all stop at 07-15.

Either the prompt or the news input has drifted toward vaguer output. Worth
diagnosing separately; normalising identity will not fix a theme that is
genuinely one-off noise, it will only make the noise visible.

---

## 3. Scope

**In scope:** give a theme a stable identity, record its per-run observations,
and display strength on the Markets page.

**Explicitly out of scope: a theme or sector momentum SCORING dimension.**

This is not caution, it is the rule established two days ago and it applies with
full force. `R3_DIMENSION_FEASIBILITY.md` rejected NSE FII/DII precisely because
its per-date cross-sectional σ is 0.00 by construction — one national number, no
symbol dimension. **Theme and sector momentum have the same shape**: every member
of a theme receives the same value on a given day, so within-theme σ is zero. It
would shift the composite level without improving ordering — the exact failure
already documented for US `macro_score` (σ 2.26) and `insider_score` (94.1% at a
single value), which together consume 0.225 of US weight and contribute no
cross-sectional information.

It would also be a threshold change: DIAGNOSIS.md §14e measured **11.6% of US
rows within ±2 points of the gate**, so any composite level shift moves admission.

Theme membership may legitimately inform **discovery admission** — which names
enter the funnel. That is not scoring and does not carry this objection.

---

## 4. Proposal

### 4.1 Stable theme identity

Add `theme_slug` alongside the existing free-text `theme`. Resolution order:

1. **Controlled vocabulary first.** A small curated list of durable themes
   (`cybersecurity`, `cloud-computing`, `renewable-energy`, `ev`,
   `digital-payments`, `ai-infrastructure`, …) with alias sets. Deterministic,
   auditable, and it collapses the six cybersecurity strings on day one.
2. **Unmatched → `theme_slug = null`** and the raw string retained.

**Do not use an LLM to normalise.** The drift is *caused* by free-text LLM
output; adding a second LLM to reconcile it makes the vocabulary
non-deterministic and unauditable. A theme that does not match the vocabulary is
recorded as unmatched, and the vocabulary is extended by an owner-reviewed edit
when a genuinely new theme recurs. Unmatched rate is itself the metric that tells
you when to extend it.

### 4.2 Per-run observation ledger

`theme_observations`: one row per (run, theme_slug) — run timestamp, market,
member symbols, member count, whether matched or unmatched. Append-only.

`watchlist` rows expire after 7 days, so today the history is only recoverable by
accident. A theme's recurrence pattern is the entire signal; it needs its own
durable record.

### 4.3 Markets page — display only

Once ~8 weeks of observations exist: recurrence (runs present / runs total),
first and last seen, member count trend, and aggregate member forward return.

Labelled **observational**, with the run count shown next to every claim. A theme
seen twice is not a trend and the surface must not imply it is.

---

## 5. What this unlocks

Theme Scout has been running since 2026-06-30 and **its output has never been
measured**. It uses an LLM to pick both the themes and the member stocks, and
those members enter research at candidate priority 3. That is admission-only, so
it clears the no-LLM-on-money-path rule — but it means an unmeasured LLM
judgement has been shaping the research funnel for five weeks.

With `theme_slug` plus the observation ledger, the answerable question becomes:
**do theme-sourced candidates outperform watchlist-sourced ones?** That is a
discovery-quality measurement, not a scoring change, and it is the first thing
that would justify or retire this agent.

It also depends on the provenance fix shipped in `73c398bf` — before that,
carried-forward candidates were relabelled `watchlist` and theme attribution was
destroyed on the round trip.

---

## 6. Sequencing

1. `theme_slug` + controlled vocabulary + `theme_observations` — no UI, no
   scoring. Backfill the 182 existing rows through the vocabulary so the five
   weeks already collected are not lost.
2. Report unmatched rate and the recurrence table. Diagnose the §2 drift toward
   one-off themes before building any surface on top of it.
3. Markets display, only once ≥8 weeks of observations exist.
4. Theme-vs-watchlist discovery-quality comparison.
5. Theme membership as a discovery-admission input — separate proposal.

Step 1 is small and reversible. Steps 3–5 each need their own approval.

---

## 7. Open questions for the owner

1. **Approve step 1?** It is additive and touches no scoring path.
2. **Sub-themes** — the original question asked about them. Nothing in the data
   supports a hierarchy yet: with 42 strings over 13 runs and 32 appearing once,
   there is no evidence of parent/child structure. Recommend deferring until the
   flat vocabulary has stabilised.
3. **Is Theme Scout worth keeping at all?** Five weeks, 182 rows, zero
   measurement, and recent output drifting toward non-themes. Step 1 makes that
   answerable rather than a matter of taste. Retiring it is a legitimate outcome.

---

## 8. Step 1 — shipped 2026-08-04

`lib/themes/vocabulary.ts` (10 slugs, aliases seeded from the 42 strings actually
observed), `watchlist.theme_slug`, and the append-only `theme_observations`
ledger. Theme Scout now resolves a slug on write and appends one observation row
per (run, theme), reporting `unmatched_themes` in its response.

**Backfill result — 32 of 42 distinct themes matched.** The 10 unmatched are
exactly the strings flagged in §2 as one-off observations rather than investable
themes: `Grid Safety`, `Tech Sector Rebound`, `Consumer Expansion`,
`Debt Reduction`, `Defensive Consumer`, `Stable Dividend Payers`,
`Energy Merger Boom`, `Global Diversification`, `Cash Flow Recovery`,
`Industrial Expansion`. They are recorded with a null slug, not guessed into one.

Recurrence is now computable for the first time — **counted in distinct run
dates**, not observation rows, because several raw strings collapse to one slug
on the same day:

| slug | dates present | % of 13 runs | first → last |
|---|---:|---:|---|
| `cloud-computing` | 8 | 62% | 06-30 → 07-15 |
| `cybersecurity` | 5 | 38% | 06-30 → 07-06 |
| `electric-vehicles` | 5 | 38% | 06-30 → 07-06 |
| `financials` | 4 | 31% | 07-06 → 07-27 |
| `renewable-energy` | 4 | 31% | 06-30 → 07-06 |

Cybersecurity's six fragments are one theme present in 38% of runs. That
statement was not expressible yesterday.

**It also confirms the §2 concern.** Every durable theme's `last_seen` is
2026-07-15 or earlier; nothing since has recurred. Whatever changed around
mid-July is a live question, and step 2 is now to diagnose it rather than build
a surface over it.

The backfill was generated *from* the TypeScript resolver rather than
reimplemented in SQL, so the vocabulary keeps exactly one implementation.

