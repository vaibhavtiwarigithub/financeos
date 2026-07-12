# Full-System Deep Audit — Kairos (repo-grounded, adversarial)

You have READ access to this repository. **Ground EVERY claim in `file:line`. Do NOT trust
docs, comments, commit messages, or prior review files — verify against the actual code.** Where
a comment/doc says X, open the code and confirm or refute X. Your job is to find where the SYSTEM
DIVERGES from what it claims to be, what is wrong, what is dead/mislabeled, and what is unsafe —
and to give concrete, file-anchored fixes.

Be adversarial and exhaustive. Assume prior reviews and the maintainer missed things (they did —
e.g. the "Feature Registry feeds scoring" and "IC gate removes survivorship" claims were both
false against the code). Do not repeat their misses.

## Product north star (audit the system AGAINST this intent, not just for bugs)

The owner's goal: **the best agentic, continuously self-learning / self-evolving trading app**, where
**the owner controls whether it trades automatically or asks for manual approval — per market (US /
India) — and when the owner turns AUTO on, the system actually trades and is NOT silently blocked.**

So beyond correctness, judge whether the code actually DELIVERS this, and hunt these two failure modes
specifically:

1. **Over-gating / dead-end autonomy.** Safety gates are correct in principle (real money), but verify
   there EXISTS a real path where, once the owner legitimately enables everything
   (`AUTONOMOUS_LIVE_ENABLED=true` + DB toggle + per-market `autonomous` mode + lease + caps set),
   a qualifying signal actually reaches a live broker order. Trace it end-to-end. Flag any gate that
   is impossible to satisfy, contradictory, permanently stubbed, or that makes autonomy fire ~never
   even under correct owner config. Distinguish "necessary safety gate" from "gate that silently
   kills the feature the owner asked for." The owner does NOT want autonomy that can never trigger.
2. **Learning/evolution theater.** Verify the self-learning loop actually CLOSES and changes live
   behavior — not just records. Does LearnerAgent → challenger → validation → champion promotion
   actually alter what ResearchAgent scores next run? Or do the learner/genome/feature-registry/edge
   loops merely write rows that nothing consumes? Any loop that "logs but never evolves live behavior"
   is a finding: name it, and state what's needed to make it real.

Weigh both against safety: the answer is not "remove gates" or "auto-promote blindly," but "is there a
correct, owner-controlled path to genuine autonomy AND genuine evolution, and does the code implement
it or only pretend to?"

## Output

Write your entire report to: `CODEX_FULL_SYSTEM_AUDIT_RESULT.md` (repo root, overwrite if present).
Structure it exactly as in the "Report format" section below. Write the file once, complete — not
incrementally. Use real `path:line` for every finding.

## Method (do this, don't skip)

1. Build a map of what actually runs: enumerate every cron/route entrypoint, every agent, every
   scorer, every money-path function. For each, trace inputs → transforms → outputs from code.
2. For each claim in `docs/arch/*`, `AGENTS.md`, `PRD.md`, `public/agent-diagrams/system-map.json`,
   and the `features/*/FEATURE_ARCHITECTURE.md` files — verify it against code. Log every DRIFT
   (doc says X, code does Y) with both `file:line` references.
3. Distinguish LIVE code from DEAD/LEGACY/DUPLICATE code. This repo has known duplication (e.g. a
   Next.js `lib/research-agent.ts` AND a Deno `supabase/functions/research-agent/index.ts`; two
   copies of scorers; retired routes returning 410). State which path actually executes in prod
   (Vercel crons + local Task Scheduler) and which is inert.
4. For anything labeled "measure-only", "shadow", "never score with", "fail-closed", "atomic",
   "no fallback", "IC-gated" — PROVE the label is true in code, or flag it as mislabeled.

## Scope — audit ALL of the following, each with what-exists / why / correct? / wrong / fix / severity

### A. Scoring & signal generation
- The 5 deterministic sub-score formulas (`lib/data/scores.ts`, `lib/data/technicals.ts`):
  correctness, discontinuities, sector/PIT issues, dead-but-computed signals, clamp/units bugs.
- Availability mask + renormalization + thin-evidence abstain (`lib/scoring/weighted-score.ts`,
  `lib/research-agent.ts`). Is the mask correct? Can a missing dim still distort? Off-by-one on the
  `<2 dims` gate?
- Weight resolution order (champion → profile → signal_weights → default) — does it actually read
  what it claims? Do defaults sum to 1.0? Per-market routing correct (US vs India champion)?
- LLM boundary: confirm the LLM never generates score/direction/size/weight (it should only write
  thesis/veto). Find any leak where an LLM number reaches a decision.
- Feature Registry: confirm active features are LOGGED-ONLY and never scored (research-agent.ts
  ~1293). Flag any place that DOES consume them. Is the whitelisted formula compiler safe (no eval)?

### B. Learning loop, validation, edge lab
- LearnerAgent: is weight mutation actually evidence-bound? Can it self-promote? Per-market isolation
  real? Does it learn from fills only (low-N) or the broad ledger?
- Validation Engine (`lib/validation/*`): walk-forward purge/embargo correct? Bootstrap seeded?
  Is promotion truly fail-closed (HTTP 412 without a passed experiment)? Any override path?
- Genome (`lib/validation/genome*.ts`): bounds enforced in code (not just documented)? What does a
  promoted genome actually change live vs what's claimed?
- EdgeScout/EdgeIC (`lib/edges/*`): is the IC universe point-in-time or static (survivorship)? Min
  cross-section size? Multiple-testing / horizon-shopping (any-horizon-wins)? Newey-West lag correct
  for overlap? Is it genuinely measure-only (writes only edge_* tables)?
- Decision ledger + label maturation: any look-ahead leakage in the forward-return labels?

### C. Agents & pipeline (each: schedule, I/O, claim-vs-reality, failure modes)
- research, paper-trade (per-market crons), position-monitor, learner, mentor, macro-sentinel,
  theme-scout, watchdog, health-triage, autonomous-shadow, autonomous-live, edge-scout/edge-ic,
  performance/nav, briefing, evaluation/p1-gate.
- Claim-ownership + CAS gates on `agent_signals` (double-fill safety). Zombie reaping. Freshness
  gates (same-market-day). Are these correct and race-safe?
- Standalone-cron vs chained-tail-call duplication (the US 0-fills fix). Confirm no double-fill and
  no starvation.

### D. Money path (highest scrutiny)
- Execution kernel (`lib/trading/execution-kernel.ts`): all gates, order, and that a failed gate
  actually blocks. Kelly sizing: no-fallback NAV, stale (>4h) fail-closed, finite guards, per-order
  cap clamp.
- Autonomous-live (`lib/trading/autonomous-live.ts`): dual gate (env + DB), per-market mode +
  per-market view-only kill switch, lease expiry, daily-cap enforcement (is live_auto_daily_cap_usd
  actually enforced now?), atomic budget RPC (`reserve_live_order_budget_v2`) — TOCTOU-free? actor
  pinned? no TS read/sum/check?
- Broker clients: Robinhood REST (`lib/brokers/robinhood/rest-client.ts`) — order account pinned,
  qty validation, token server-side. Kite REST. Manual gateways (`app/api/broker/orders`,
  `app/api/kite/order`) — owner + kill-switch + drift + notional + sell-only-if-held.
- Migration reproducibility: RPCs that exist in DB but have NO migration file on disk (e.g.
  reserve_live_order_budget_v2). List them.

### E. Security (verify EVERY route + table)
- For every `app/api/**/route.ts`: list the auth check (requireOwner / verifyCronSecret / NONE).
  Flag every unauthenticated route, especially any that mutate state or burn metered APIs. (Known
  miss: `app/api/live-portfolio/import-csv/route.ts` uses getUser, not requireOwner.)
- RLS: for every table holding money/PII/secrets, confirm policies (service-role-only or owner-
  scoped). Flag any `USING(true) TO authenticated/anon`. Confirm migration 142 scoping held.
- Secrets: hardcoded literals anywhere (edge functions had `fos-cron-...`); service key never client-
  side; no secret in logs/responses; CSP/headers.
- Vault: PIN timing-safety, fail-closed when unconfigured, no default fallback.

### F. Data & multi-market
- Provider layer + av-cache + daily budget guard: fail-closed correctness. India (Yahoo/NSE/Kite)
  vs US parity. Currency isolation (₹ vs $ pools never summed). PIT/adjusted-price consistency.

### G. Past-trade / behavior feature (partially built)
- `import-csv` (parser robustness, owner gate, symbol remap, SHR classification, dedup of partial
  fills), `enrich` (calendar vs trading days, forward/backward price search leakage, adjusted vs raw
  price mixing, hardcoded macro chronology), `trade_decisions` mutation vs immutability.

### I. Product-intent / north-star reality check
- **Autonomy actually works when enabled:** trace the full path from a qualifying signal to a
  submitted live order under correct owner config (env flag + DB toggle + per-market `autonomous`
  mode + unexpired lease + caps set + kill switches off). Does it complete? List every gate on the
  path and whether it's satisfiable. Flag over-gating, contradictions, permanent stubs, or dead-ends
  that mean autonomy never fires even when the owner asked for it.
- **Per-market owner control is clean:** US and India `off`/`manual`/`autonomous` are truly
  independent; manual mode really asks for approval; autonomous mode really submits without per-order
  clicks; view-only kill switch and mode interact sanely (no combination that deadlocks or that
  bypasses a kill).
- **Self-learning/evolution is real, not theater:** does champion promotion actually change live
  scoring next run? Does the genome actually drive entry/exit/sizing live once promoted? Are the
  feature-registry and edge-lab loops connected to anything that changes trading, or logging-only?
  For each learning mechanism, state: writes rows? consumed live? closes the loop? — with `file:line`.
- **Balance:** identify where safety and the owner's autonomy/evolution intent are in genuine tension,
  and recommend the correct resolution (owner-controlled path, not gate removal or blind auto-promote).

### H. Docs/diagram drift register
- A table of every material claim in docs/arch, system-map.json, AGENTS.md, PRD that does NOT match
  code, with both references and the correction.

## Report format (write to CODEX_FULL_SYSTEM_AUDIT_RESULT.md)

1. **Executive verdict** — the 5–10 most important truths about the system's real state.
2. **Ranked findings table** — Rank | Severity (CRITICAL/HIGH/MED/LOW) | Area | Finding | `file:line`
   evidence | Concrete fix. Money-path and security findings outrank cosmetics.
3. **Dead / mislabeled / duplicate code** — what runs vs what's inert; every mislabel (a
   "measure-only" that isn't, an "active" that's inert, a "fixed" that drifted).
4. **Security matrix** — route/table → auth/RLS status → risk.
5. **Money-path integrity** — gate-by-gate confirmation or defect list.
6. **Statistical-validity audit** — leakage, survivorship, overfitting, horizon, sample-size across
   scoring/learning/edge lab.
6b. **Autonomy & evolution reality check** — (a) the end-to-end enabled-autonomy trace and whether it
   completes or dead-ends; (b) per-market owner-control correctness; (c) a table of every learning
   mechanism → writes rows? / consumed live? / loop closed? — flagging every "logs but never evolves"
   case; (d) where safety vs the owner's auto/evolve intent genuinely conflict + the right resolution.
7. **Docs↔code drift register** — the table from §H.
8. **What I could NOT verify** — be honest about anything you couldn't fully trace, and how to prove it.
9. **Prioritized fix plan** — ordered, each mapped to the finding rank.

Be concrete enough that each fix is implementable from your `file:line` + description alone. Do not
soften. If the system's real behavior contradicts its own documentation, that contradiction is the
finding.
