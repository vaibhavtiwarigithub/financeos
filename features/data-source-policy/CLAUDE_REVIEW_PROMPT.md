# Claude Review Prompt — Data Source Policy + Canonical Evidence Router

Review the **architecture only** in
`features/data-source-policy/FEATURE_ARCHITECTURE.md` for Kairos (FinanceOS), a
Next.js 15 + Supabase + Vercel quant app supporting paper/live workflows in US and
India. Do not implement code.

Read first:

- `AGENTS.md`, `WORK_LOG.md`, and `CLAUDE.md`
- `features/data-availability-layer/FEATURE_ARCHITECTURE.md`
- `features/data-provider-abstraction/FEATURE_ARCHITECTURE.md`
- `lib/data/provider-interface.ts`
- `lib/data/provider-fetch.ts`
- `lib/data/fundamentals.ts`
- `lib/data/webull-data.ts`
- `lib/data/evidence.ts`
- `lib/data/scores.ts`
- the availability-mask/renormalization section in `lib/research-agent.ts`
- `app/api/data-providers/route.ts` and Settings → Data
- `docs/arch/04-database-schema.md`, `docs/arch/05-crons-and-scheduling.md`, and
  `docs/arch/09-learning-loop.md`

Ground truth from a live, read-only Webull MCP probe on 2026-07-13:

- `tools/list` returned 71 tools.
- Analyst/financial calls require `{symbol, category:"US_STOCK"}`; the current
  adapter omits category and silently returns null.
- Analyst rating uses `strong_buy`, `buy`, `hold`, `under_perform`, `sell`, `number`.
- Target price returns mean/low/high/median/currency/effective date.
- Forecast EPS is a period array using `est`, `actual`, and `reported`.
- Financial indicators are period arrays under `{currency, values}`.
- Current Webull cache is process-local and not durable on Vercel.
- Webull orders must remain structurally unreachable (`orderCapable=false`).

Evaluate the design adversarially, ranked most severe first. For each finding give
file section, severity, concrete failure scenario, and minimal architecture fix:

1. **Trading correctness:** Can provider preference/off/failure or weight
   renormalization create a newly eligible entry merely by removing evidence? Is
   shadow evaluation + entry-flip gating sufficient?
2. **Semantic correctness:** Can annual/quarterly/TTM/forward values, percentages vs
   fractions, period selection, or currencies still be silently substituted?
3. **Policy lifecycle:** Are immutable versions + active pointer + evaluation proof
   reproducible, atomic, rollback-safe, and resistant to stale validation?
4. **Provider eligibility:** Is capability-level maturity/entitlement/contract state
   sufficient, or can a DB row enable an uncompiled/unvalidated capability?
5. **Quota/pacing:** Does the design correctly distinguish unknown daily limits,
   rate limits, subscriptions, shared quotas, reservation races, and Vercel bounds?
6. **Cache/queue correctness:** Any stale poisoning, negative-cache, duplicate claim,
   cross-market/currency, partial-write, or dead-letter failure mode?
7. **Webull specifics:** Validate the proposed parsers, consensus math, EPS period
   selection, financial-array mapping, session behavior, token safety, and prompt
   injection boundary.
8. **Architecture fit:** Does this consolidate the existing provider/cache/evidence
   systems, or accidentally create a parallel truth layer?
9. **Supabase security:** RLS, service-role boundaries, SECURITY DEFINER search path,
   append-only lifecycle, payload limits, and owner-only Settings controls.
10. **Product usability:** Can Vaibhav safely leave everything on Auto? Are advanced
    controls understandable without making him manually manage quotas?
11. **Operational rollout:** Is dual-run/shadow evidence adequate per market? Is the
    five-day Webull sample sufficient? Is rollback genuinely behavior-safe?
12. **Scope safety:** Confirm no order path, execution quote source, signal weight,
    or live autonomy is enabled by this feature.

Also identify stale assumptions or contradictions in the two older feature docs that
the new architecture should explicitly supersede.

Output:

1. prioritized findings;
2. concrete architecture edits;
3. what is sound;
4. recommended build order;
5. single riskiest assumption to validate first;
6. final verdict: `approve`, `approve with changes`, or `redesign`.

