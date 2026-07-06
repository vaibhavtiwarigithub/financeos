# Risk Posture & Goal Tracker — Implementation Spec

**Audience:** any implementing model/engineer. Follow exactly. Approved 2026-07-06.
**Position in queue:** build AFTER the current build-all queue (Phase 1 ✅ → P0 improvements → Portfolio Constructor → Phase 2 → Gateway → Phase 3), or interleave with P0 items — it touches only settings/config surfaces, no learning math.

**Design verdicts already locked (do not revisit):**
- A **return target is NEVER an agent parameter.** "Make 30% in a month" cannot be wired into sizing/threshold — cranking dials toward a target only adds variance (gambler's ruin) and teaches the learner that luck is skill. Goals are a *measured dashboard*, postures are the only agent-facing knob.
- Environment-adaptive risk (bet more in favorable regimes) is **already covered** by Phase 2 (calibrated Kelly sizing) + Phase 3 (regime router). Nothing here duplicates it. No hardcoded bull/bear switches (locked design rule).

---

## Part A — Profile rollup (close the gaps in conservative/balanced/aggressive)

Today the profile sets 6 dials (`app/api/settings/risk-profile/route.ts` PROFILES map: score_threshold, position_size_pct, stop_loss_pct, target_pct, max_positions_per_sector + the scoring-weight fallback). Three gaps:

**A1. Kill-switch thresholds scale with profile.** `lib/kill-switches.ts` hardcodes −5% daily / 20% drawdown / 40% accuracy. An aggressive book trips −5% days by design. Add to the PROFILES map in `app/api/settings/risk-profile/route.ts`:
```
conservative: { ..., ks_daily_loss_pct: -4, ks_drawdown_pct: 15, ks_accuracy_pct: 45 }
balanced:     { ..., ks_daily_loss_pct: -5, ks_drawdown_pct: 20, ks_accuracy_pct: 40 }
aggressive:   { ..., ks_daily_loss_pct: -7, ks_drawdown_pct: 25, ks_accuracy_pct: 35 }
```
Migration `070_profile_killswitch.sql`: add nullable columns `ks_daily_loss_pct, ks_drawdown_pct, ks_accuracy_pct` to `strategy_config`. `checkKillSwitches` reads them (resilient: absent column/null → current hardcoded defaults). The route's PUT writes them when a profile is applied; individual override allowed like the other dials.

**A2. Exit hysteresis into the profile.** `position-monitor` hardcodes exitThreshold = entry−15 (floor 35). Add `exit_hysteresis` to PROFILES (conservative 10 / balanced 15 / aggressive 20) + nullable `strategy_config.exit_hysteresis` column (same migration 070). Monitor reads it resiliently.

**A3. Surface champion override.** Settings page (risk profile card): when a promoted champion exists for the active market (`strategy_versions is_champion=true`), show a muted note: "⚠ A promoted champion currently overrides this profile's scoring weights (profile still controls sizing/exits/kill-switches)." Read via the existing supabase client; no new API.

## Part B — Time-bound posture presets (auto-revert)

A "posture" = applying a profile's dials **with an expiry**, after which the system reverts to the base profile automatically.

**Migration `071_posture.sql`:** add to `strategy_config`: `posture text` (nullable — when set, one of conservative|balanced|aggressive), `posture_expires_at timestamptz` (nullable), `base_risk_profile text` (nullable — what to revert to).

**API:** extend `app/api/settings/risk-profile/route.ts` PUT: optional body `{ posture, posture_days }`. When present: save current `risk_profile` into `base_risk_profile`, apply the posture's PROFILES dials (incl. A1/A2 fields), set `posture_expires_at = now() + posture_days`, journal to `decision_journal` (entry_type `posture_change`, summary "Posture aggressive for 30d (expires <date>), reverts to balanced"). A PUT with `{ posture: null }` cancels early → immediate revert.

**Auto-revert check:** in the research cron route (both markets hit it daily) — before gathering symbols: if `posture_expires_at` is set and past, restore `base_risk_profile`'s dials, clear posture fields, journal `posture_expired`. Resilient to missing columns (pre-071 → no-op).

**UI (Settings, risk-profile card):** posture selector (the 3 profiles) + duration (1w/2w/1m/2m) + Apply; an active posture shows a banner "Posture: AGGRESSIVE until Aug 6 → reverts to balanced" with a Cancel button. Match existing card/pill styling.

## Part C — Goal tracker (dashboard, never an agent input)

**Migration `072_goals.sql`:** `trading_goals(id bigserial pk, created_at, market text default 'us', target_return_pct numeric, horizon_days int, start_nav numeric, start_date date, status text default 'active' /*active|achieved|missed|canceled*/, note text)`. RLS disabled.

**API `app/api/goals/route.ts`:** POST creates a goal (auth: logged-in user) — captures start_nav from the market's paper pool. GET returns active goal(s) + computed feasibility + progress:
- `required_daily_pct = (1+target/100)^(1/horizon_days) - 1`
- `realized_daily_pct` = mean daily NAV return from `paper_performance` (that market, last 90d, resilient)
- `progress_pct` = (current NAV − start_nav)/start_nav vs target; `on_track` boolean vs time elapsed
- `feasibility`: compare required vs realized ("requires 1.31%/day; realized edge last 90d: 0.08%/day — far above demonstrated edge" | "within demonstrated range"). Plain honest strings, no false precision.
- Status auto-flips achieved/missed when target hit or horizon passed.

**UI:** Morning Briefing/dashboard card "Goal" — target, progress bar, on-track marker, the feasibility sentence, days left. Small "Set goal" form (target %, horizon, market). NOWHERE does any agent route read `trading_goals` — enforce by convention + a comment in the table's migration: "READ BY UI ONLY — never an agent input (see Decision 34)."

## Docs
- PROJECT_DECISIONS: **Decision 34** — "Goals are measured, postures are applied: return targets are never agent parameters" (capture the gambler's-ruin + learning-pollution reasoning; posture auto-revert; kill-switch/hysteresis rollup).
- WORK_LOG entry; Settings-related notes in ARCHITECTURE if a session section exists for the date.
- system-map: no new node needed (no agent-to-agent flow change; posture is config). Add a `history` entry only if the diagram text mentions profile dials.

## Acceptance
- tsc + build + (once vitest lands) tests pass. All three migrations resilient: absent columns/tables → exact current behavior.
- Posture expiry verified by manually setting `posture_expires_at` in the past and running the research cron → dials revert + journal row.
- Goal feasibility math unit-tested (pure function: target/horizon/realized → required, feasibility string).
- Migrations handed to the user as clickable links + full paths.
