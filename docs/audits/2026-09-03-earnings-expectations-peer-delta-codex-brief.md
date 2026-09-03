# Codex brief — Earnings Expectations & Peer Delta architecture review

Date: 2026-09-03
Companion: `features/earnings-expectations-peer-delta/FEATURE_ARCHITECTURE.md`
Recommended model: **sol / max** — adversarial architecture review, not planned implementation.

**You are explicitly authorized to overrule this architecture where the evidence disagrees with it.**
The Architect (Claude, Sonnet 5) made a RESHAPE call, four scope cuts, and thirteen numbered
decisions. None of that is binding on you. If your own re-derivation contradicts a claim below, the
claim is wrong and you should say so plainly, the same way this document itself corrects claims made
in the user's original prompt.

---

## 0. Your job

1. **Independently reproduce every claim in §2** below. Do not trust this document's numbers —
   re-run the SQL, re-check the source docs, re-run the entitlement probes.
2. **Adversarially review the architecture document** end to end: is the RESHAPE justified, are the
   four scope cuts (§0 of the architecture doc) correct, is the data model sound, do the acceptance
   criteria actually close the traps they claim to close?
3. **Do NOT implement.** No migration, no provider activation beyond read-only entitlement/doc
   probes, no code in `app/`, `lib/`, or `components/`, no scoring change. This is architecture
   review only, matching the scope Vaibhav authorized.
4. Report a verdict: does this architecture survive adversarial review, and what — if anything —
   should change before it goes to Vaibhav for approval.

---

## 1. How to verify anything here

- Production DB via Supabase MCP (`execute_sql`). Read distributions, not single rows.
- PostgREST silently caps reads at 1,000 rows — paginate anything feeding a percentage or count.
- `.env.local` in this repo is gitignored and local-only; it may NOT reflect Vercel's production
  environment variables. Do not assume a value you see locally (e.g. `AV_DAILY_BUDGET` unset) is what
  production actually runs with.
- The two Alpha Vantage entitlement probes referenced below (§2.3) were made with the project's real
  `ALPHA_VANTAGE_API_KEY` from `.env.local`, read-only GET requests, symbols `IBM` and `EXEL`. If you
  re-run them, that consumes real quota against whatever the production budget actually is (§3.1) —
  keep any re-probe to the minimum needed to confirm or refute a specific claim, not exploratory.
- Finnhub and Alpha Vantage's own documentation sites are JavaScript SPAs; a plain HTTP fetch/curl
  will return only the page shell. Use a browser tool that executes JS, or `curl` the actual API
  endpoints (which return real JSON) rather than the doc pages if you need to re-verify field shapes.

---

## 2. Claims to independently reproduce

### 2.1 Production database counts (SQL provided — re-run verbatim, then vary it adversarially)

```sql
-- Consensus snapshot coverage
select
 (select count(*) from earnings_consensus_snapshots where market='us') as consensus_snapshots,   -- claimed 56
 (select count(distinct symbol||report_date) from earnings_consensus_snapshots where market='us') as symbol_report_events, -- claimed 19
 (select count(distinct symbol) from earnings_consensus_snapshots where market='us') as symbols,  -- claimed 9
 (select count(*) from decision_observations where market='us') as us_decision_obs,               -- claimed 5911
 (select count(*) from decision_observations where market='us' and features->'analyst' is not null) as us_obs_with_analyst_evidence; -- claimed 4125

-- Analyst target field — NOTE the correct JSON path (the user's original prompt implied a
-- top-level key; the real path is nested under fundamental)
select count(*) from decision_observations
where market='us' and (features->'fundamental'->>'analyst_target') is not null;  -- claimed 157

-- Peer coverage
select
 (select count(*) from symbol_profiles where market='us' and peers is not null and array_length(peers,1) > 0) as us_profiles_with_peers,  -- claimed 97
 (select count(*) from symbol_profiles where market='us') as us_profiles_total,  -- claimed 187
 (select sum(array_length(peers,1)) from symbol_profiles where market='us' and peers is not null) as us_peer_relationships,  -- claimed 534
 (select count(*) from symbol_profiles where market='india' and peers is not null and array_length(peers,1) > 0) as india_profiles_with_peers,  -- claimed 0
 (select count(*) from symbol_profiles where market='india') as india_profiles_total;  -- claimed 51

-- Alpha Vantage call budget — the single most consequential number in the whole architecture
select provider, cache_date, calls from provider_budget where provider='alpha_vantage'
order by cache_date desc limit 14;
-- claimed: 35, 71, 60, 36, 8, 45, 67, 56, 67, 47 (most recent 10 days as of 2026-09-03) —
-- ADVERSARIAL CHECK: is `calls` gated against any enforced ceiling, or purely observational? Read
-- lib/data/provider-fetch.ts in full, not just the line cited below, to determine whether exceeding
-- the default budget actually blocks a call or just logs it.
```

`lib/data/provider-fetch.ts:29` — the code-level default: `dailyBudget: Number(process.env.AV_DAILY_BUDGET ?? 25)`.

**What this brief could NOT determine and you should:** whether production Vercel env sets
`AV_DAILY_BUDGET` above 25, and if so to what. If you have Vercel project access, check directly. If
not, say explicitly that this remains unconfirmed rather than assuming either answer.

### 2.2 Source file claims — re-read each file in full, not just the excerpt below

- `lib/data/earnings-pit.ts` (303 lines) — append-only PIT capture, Finnhub-sourced, US-only.
- `lib/data/analyst.ts` (46 lines) — `scoreAnalyst()`, Finnhub `/stock/recommendation`, measure-only.
- `lib/data/symbol-profile.ts` (220 lines) — `symbol_profiles.peers`, Finnhub `/stock/peers`, no param
  passed (defaults to `grouping=subIndustry` per Finnhub's own docs — verify this default is real,
  not assumed, since it was not confirmed against Finnhub's docs in this pass, only inferred from
  their parameter description).
- `lib/data/peer-moves.ts` (80 lines) + `app/api/peer-moves/route.ts` (156 lines) — display-only,
  confirmed no import outside its own route/test via `grep -rl`. Re-run that grep yourself; a single
  grep pass can miss a dynamic import or a re-export.
- `lib/events/vocabulary.ts` (146 lines) — `guidance_cut`/`guidance_raised` types exist;
  **this brief did NOT query `market_events` for actual row counts of these types** — do that:
  ```sql
  select event_type, count(*) from market_events where event_type in ('guidance_cut','guidance_raised') group by 1;
  ```
- `features/relationship-graph/P0_COVERAGE_STUDY.md` and `FEATURE_ARCHITECTURE.md` — read in full;
  this brief only excerpted the headline numbers (5/79, 6.3%, structural GAAP anonymity finding).
- `lib/research-agent.ts` around lines 1490–1730 — the `analystScore` (composite) vs. `analystResult`
  (Finnhub recommendation, from `scoreAnalyst()`) naming collision. Confirm independently that
  `analystScore` truly never includes the Finnhub recommendation dimension — trace
  `computeWeightedAnalystScore`'s `scoreOf` object at line ~1707 and confirm `analystResult`/
  `analyst` is genuinely absent from it (this brief traced it but did not open
  `computeWeightedAnalystScore`'s own implementation file).

### 2.3 External source claims — primary sources, with the exact evidence found

- **Alpha Vantage `EARNINGS_ESTIMATES`**: confirmed live via
  `https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol=IBM&apikey={real key}` and
  `...symbol=EXEL...` — both returned real, non-error JSON with `estimates[]` array,
  `fiscal year`/`fiscal quarter` horizon rows, `eps_estimate_average/high/low`,
  `eps_estimate_analyst_count`, `eps_estimate_average_{7,30,60,90}_days_ago`,
  `eps_estimate_revision_{up,down}_trailing_{7,30}_days`, revenue equivalents. No entitlement error,
  no premium-lock message (compare to `TIME_SERIES_INTRADAY`'s doc page, explicitly marked
  "Trending Premium" — `EARNINGS_ESTIMATES`'s doc section carries no such marker).
  **Re-verify**: does a THIRD symbol, ideally one NOT in Kairos's current universe and with thin
  analyst coverage, also return real (not empty/degraded) data? IBM and EXEL are both reasonably
  well-covered names; this brief did not test a genuinely thin-coverage small-cap.
- **Finnhub earnings-calendar basis**: verified verbatim from
  `https://finnhub.io/docs/api/earnings-calendar` (rendered via a JS-executing browser, not plain
  curl): *"EPS and Revenue in this endpoint are non-GAAP, which means they are adjusted to exclude
  some one-time or unusual items."* Also: *"Free Tier: 1 month of historical earnings and new
  updates."* **Re-verify** this text is still current — documentation pages change.
- **Finnhub `/stock/eps-estimate`**: doc section header reads *"Earnings Estimates Premium"* with
  *"Premium: Premium Access Required"* explicitly stated. Fields: `epsAvg/High/Low`,
  `numberAnalysts`, `period`, `freq` — no revision-history fields documented.
- **Finnhub `/stock/peers`**: `grouping` parameter documented with values `sector | industry |
  subIndustry`, default `subIndustry`.
- **Hameed, Morck, Shen & Yeung, NBER w15833** ("Information, analysts, and stock return
  comovement"): abstract confirms asymmetric co-movement — thinly-covered stocks move with
  well-covered peers' firm-specific price changes; the reverse does not hold. **This is the empirical
  basis for the architecture's asymmetric peer-weighting design (§7.2 of the architecture doc) — check
  whether that inference is a fair reading of the paper**, not an overreach. Fetch
  `https://www.nber.org/papers/w15833` yourself and read past the abstract if a working paper PDF is
  accessible.
- **Lu & Skinner SSRN 3687764** ("Moving Forward: Management Guidance and Earnings Announcement
  Returns"): **SSRN returned HTTP 403 to this session's fetch attempt.** The paper is cited by title/
  authors only in the architecture doc; its actual findings were never confirmed. If you can access
  it (a different fetch path, a library proxy, or a mirror), verify it actually supports the
  guidance-related design choices in §4.6 of the architecture doc, or flag that it doesn't.
- **SEC EDGAR PIT timestamp claim** ("Works. `acceptanceDateTime` on 79/79, intraday-precise"): this
  was NOT re-verified in this pass — it is carried over from the relationship-graph P0 study
  (2026-07-16). Confirm it's still accurate before the architecture doc leans on it for the Stage 0b
  guidance-source discussion.

---

## 3. Architecture-to-file checklist

For each claim the architecture document makes about existing code, confirm the cited file/line still
says what's claimed (files move, get refactored, line numbers drift):

- [ ] `lib/data/provider-fetch.ts:29` — `AV_DAILY_BUDGET` default still 25
- [ ] `lib/data/scores.ts:240-248` — `analyst_target`/`analyst_target_mode: "observational_only"`
- [ ] `lib/data/symbol-profile.ts:178` — India peers explicitly `[]`, comment intact
- [ ] `lib/risk/earnings-repricing.ts` — still a freshness barrier, not a scoring input
- [ ] `research-agent.ts:1502-1510` comment — still states Finnhub analyst dimension is logged
      evidence only
- [ ] `research-agent.ts:2213-2214` — `analyst_target`/`analyst_upside_pct` still inserted into
      `signal_score_history`; confirm whether the missing-column issue (§3.2 below) actually causes a
      silent failure or a thrown, caught, logged error
- [ ] `lib/edges/folds.ts:77` — still refuses `stepSessions < horizonSessions`
- [ ] `lib/shadows/registry.ts:1-9` — `ShadowLifecycle` enum unchanged
- [ ] `supabase/migrations/20260715210100_earnings_consensus_snapshots_vintages.sql` — RLS pattern
      (deny anon, authenticated select, service_role write) still the convention to copy

### 3.1 The single highest-priority open question

**What is Kairos's actual contracted Alpha Vantage plan and its real daily/rate ceiling?**
Production is consuming 35–71 calls/day against a code default of 25/day. This number bounds
literally every other decision in the architecture (Stage 1 symbol count, capture cadence, whether
Stage 2's peer-basket estimate fetches are affordable at all). Resolve this before endorsing any
specific Stage 1 scope number the architecture proposes (it proposes ≥60 symbols as a *placeholder*,
explicitly not a commitment, pending this answer).

### 3.2 A pre-existing, out-of-scope defect surfaced during this review

`research-agent.ts:2213-2214` inserts `analyst_target`/`analyst_upside_pct` into `signal_score_history`
on every research run. This session found `signal_score_history` has **no such columns**
(`information_schema.columns` query, `column_name ilike '%analyst%'` → only `analyst_score`). The
insert call captures its error into `scoreHistErr` but this brief did not trace what happens to that
variable afterward — does the whole `signal_score_history` row silently fail to write (losing score
history for the run), or does something else happen? **This is unrelated to the earnings-expectations
feature and should not be fixed as part of it** — but it's a real defect worth a separate ticket, and
you should determine its actual blast radius (does the research pipeline continue past a failed
`signal_score_history` insert, or does it propagate?).

---

## 4. Security and look-ahead traps to specifically probe

1. **The dual-timestamp peer-leakage check (architecture §11.3, acceptance criterion #9).** A peer
   reporting AFTER the target must not leak into the target's earlier decision. The architecture
   requires checking both the peer basket's `effective_from` AND the individual peer's own
   `earnings_expectation_snapshots.captured_at` against the target's `decision_ts`. Verify this is
   actually suffient — construct a concrete adversarial timeline (target reports Monday, peer A's
   basket membership was accepted the prior Friday but peer A itself doesn't report until Tuesday) and
   confirm the design as written correctly excludes peer A's Tuesday data from Monday's decision.
2. **The basis-prospective-only rule (architecture §4.2, §12.3).** The architecture claims Finnhub's
   non-GAAP statement can resolve the basis contract "prospectively only," never rewriting the 56
   existing null-basis rows. Confirm the proposed schema (§11.1, a NEW table
   `earnings_expectation_snapshots`, distinct from the existing `earnings_consensus_snapshots`) can't
   accidentally be joined against the old table in a way that implicitly assumes the old null-basis
   rows are non-GAAP too. This is exactly the kind of frozen-history violation the codebase's own
   rules prohibit.
3. **Weighted-median η with a 5-member basket.** A weighted median over 5 elements is nearly a
   simple median except for how weights break ties/ordering. Confirm the exact weighted-median
   algorithm the architecture implies (it does not specify one — this is a real gap you should flag)
   behaves sanely at n=5, the minimum basket size, not just at larger n.
4. **The `guidance_midpoint` generated column** (`(guidance_low + guidance_high) / 2`). Confirm this
   correctly returns NULL (not a computed garbage value) when only one of `guidance_low`/
   `guidance_high` is set — Postgres generated-column arithmetic on a NULL operand should already do
   this, but verify rather than assume.
5. **ETF exclusion.** The architecture says peer comparisons reuse `classifyInstrument`/
   `KNOWN_US_ETFS`. Confirm no ETF can enter a peer basket via Finnhub's `/stock/peers` response
   (Finnhub's peer endpoint is company-oriented, but verify it doesn't return an ETF for, say, a
   sector-concentrated single name where Finnhub might suggest a sector ETF as a "peer").

---

## 5. Mutation tests required (if this proceeds to Builder)

Not build now, but specify what a Builder's test suite MUST prove by reverting the fix and watching
the test fail, per this codebase's own established discipline (`b3f505d6`'s cost-fix tests, this
session's precedent):

1. Reverting the dual-timestamp peer-leakage check → a look-ahead-contaminated η should reappear and
   a detector should fail.
2. Reverting the basis-match requirement in any beat/miss comparison → a GAAP-actual-vs-adjusted-
   estimate comparison should silently succeed where it should refuse.
3. Reverting the `MIN_CROSS_SECTION`/horizon-aware independent-window spacing reuse (i.e. reverting to
   a flat calendar-day rule) → should fail the same class of test that caught the `edge-readiness.ts`
   bug on 2026-09-03.
4. Reverting the "eligible cohort, not all-scored" requirement in the baseline-vs-baseline-plus-
   feature comparison (acceptance criterion #16) → should fail.

---

## 6. Deployment-versus-local verification distinction

Nothing in this architecture is implemented, so there is no deployment to verify yet. When it is:
apply the same rule this codebase has already learned the hard way (`mentor/evaluate`'s 94.8s local
run that would 504 in production, `macro-read`'s 60→150s `maxDuration` fix) — a local dev-server
verification proves the code, not the deployment. Any Builder claiming this feature "works" must show
production evidence (a cron run, an `agent_alerts` row, a `provider_budget` count), not a local
`npm run dev` session.

---

## 7. Your verdict should answer

1. Does the RESHAPE call (defer guidance extraction, defer India, reuse `ShadowLifecycle`, treat the
   AV budget as an open blocker) survive your independent review, or should any of those four cuts be
   reversed?
2. Is the Alpha Vantage vs. Finnhub source decision (§12.2 of the architecture doc) still correct
   after your own re-verification, including the thin-coverage-symbol test in §2.3?
3. Is the data model (§11) sufficient, or does it under- or over-build relative to what Stage 0/1
   actually needs?
4. Are there acceptance criteria (§14 of the architecture doc) that don't actually close the trap they
   claim to close?
5. What is the single largest integrity risk in this architecture, in your own assessment — not
   necessarily the same one this brief names (§3.1)?
6. Explicit overrule: is there anything in the architecture document you disagree with outright? Say
   so and why, the same way this document overruled parts of the user's original prompt (the
   lifecycle-taxonomy duplication, the unresolved AV budget, the wrong JSON path for analyst targets).
