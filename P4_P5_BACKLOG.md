# P4 / P5 Backlog — captured 2026-07-08

Deferred by owner until existing tasks (P2 portfolio-benchmarks, safe-P3 watchdog,
current backlog) are complete. Nothing here is started.

## Quick fixes (bug-class, can pull forward)
- **Automation page stale copy** (`app/dashboard/settings/automation/page.tsx` lines
  ~200/205/215-216/263 + `DashboardHome.tsx:119`): claims "all jobs run locally via
  Windows Task Scheduler; cloud crons decommissioned" — the OPPOSITE of reality. All
  `kairos-*` run on **Supabase pg_cron → Vercel** (survive laptop-off); only `db-backup`
  is Windows. Also `lib/schedule.ts` runner/labels still say "Windows Task Scheduler".
  Correct the copy to reflect cloud pg_cron. (Also the health-triage "curl localhost"
  recovery text — same stale-local assumption.)

## Done since capture (2026-07-08)
- Automation-page stale copy + calendar dash/underscore double-row + stale-check
  "PC off" recovery text → all corrected to cloud pg_cron reality.
- Theme Scout US coverage: curated structural spine (AI/semis/nuclear-energy) always
  represented + relaxed the anti-AI-dedup rule + caps raised to 4 themes × 3 tickers.

## P4

### P4.0 — India Theme Scout (follow-up to the US spine)
Theme Scout is US-only (LLM prompt demands US tickers, tickerExists validates via AV
OVERVIEW). India gets no thematic candidates. Add an India-scoped run that screens NSE
names (Yahoo/NSE source) with the same structural spine, writing to the India watchlist.
Bigger than the US prompt tweak — needs an India ticker-existence check + India watchlist wiring.

### P4.1 — Per-account, per-symbol risk analytics + advisory suggestions (US + India)
- Extend Risk Analytics to **per connected account**, not just one book.
  - US Robinhood: Trading `605420660` (order-capable) + `965848641` (read-only). Alpaca too.
  - India: Zerodha Kite + Upstox.
- Per symbol per account: position vs name/sector/notional limits, concentration, stop
  distance, unrealized P&L, drift from target. **Advisory suggestions** (trim / hold / add
  + WHY). NEVER auto-acts — owner clicks. Mirror US ($) and India (₹), per-currency.
- Right way: read-only analysis layer over each account's live snapshot; reuse the
  existing constructPortfolio limits; surface as cards per account.

### P4.2 — Unify Live Portfolio nav + global US/India switch drives all left-panel
- Fold "Live Portfolio (US)" + "India Live + Signals" into ONE "Live Portfolio".
- The **top US/India switch becomes global market context**: set it once and EVERY
  market-scoped left-panel page (Live Portfolio, Risk, Paper Portfolio, Briefing, Markets)
  shows that market until toggled again.
- Audit which left-panel pages are already market-aware vs hardcoded to one market; make
  the non-conforming ones read the global switch.

### P4.3 — Morning/Evening briefing market handling
- Option A: brief follows the global switch (shows selected market).
- Option B (recommended): **combined brief with clearly separated US ($) and India (₹)
  sections** — morning + evening for both, properly labeled, so you see both without
  toggling. Same for any left-panel section that is country-specific: show both countries'
  info on the combined page.

### P4.4 — Multi-tenant foundation (give app to friends/family)
- As-is: **single-owner** — `requireOwner` everywhere, one profile, one shared vault of the
  OWNER's keys, agents/learning are global. Multi-user does NOT work today.
- Needs: per-user auth + data isolation (RLS by user_id on every table), per-user broker
  OAuth (their RH/Alpaca/Zerodha/Upstox), an **admin role (owner) to grant/revoke** access,
  per-user agent state. Broker keys are ALWAYS the user's own (their money). Foundation-level
  rebuild.

## P5

### P5.1 — Share learnings across tenants (opt-in)
- New users' agents start fresh by default. Owner can OPT-IN to seed a new tenant with the
  owner's champion genome + signal weights + trade-memory RAG (seed-on-invite), OR expose a
  shared read-only "global learnings" pool tenants can inherit. Design choice to make.

### P5.2 — Settings / API-key sharing policy in multi-tenant
- Platform/data + LLM API keys stay the OWNER's. Per-tenant choice: use owner's keys
  (owner pays) vs bring-your-own. Broker keys always the tenant's. Some settings global
  (owner platform config), some per-user (their risk limits, market focus). RBAC.

## Answered questions (context)
- **Broker/account sync on weekdays — keep it.** `kairos-broker-sync` (every 30m, mkt hours)
  reconciles live order status/fills + refreshes the live-account NAV snapshot that feeds
  Live Portfolio, the G3 risk gate, and the briefing. Required once any live order exists;
  a cheap near-no-op when there are no open live orders. NOT the paper-fill path.
