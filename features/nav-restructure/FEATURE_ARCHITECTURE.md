# Feature: Left-nav restructure (funnel order + surface LLM config)

Last updated: 2026-07-12
Update this file when: NAV_SECTIONS changes, a route is added/removed/renamed, or the
LLM-config entry point moves.

## Problem
- ~20 sidebar items; grouping ("Daily / Portfolio / Agents & Research / Discovery / Learn /
  Settings") doesn't mirror the user's actual funnel.
- "Morning Briefing" is the home page but reads like a feature, not the app home.
- The per-flow LLM model picker is buried at Agents → "⚙ LLM Config" tab (default tab is
  Paper), so users look in Settings and don't find it.
- Three portfolio surfaces (Paper / Live-US / India) read as duplicates.

## Decision (this pass — LOW RISK, no routes removed)
Reorder + relabel `NAV_SECTIONS` in `components/dashboard/DashboardShell.tsx` to follow the
funnel **Overview → Markets → Signals → Portfolio → Research → Discovery → Learn → Settings**,
and:
1. Rename the home item "Morning Briefing" → **"Home"** (route `/dashboard` unchanged).
2. Split the old "Daily" into **Overview** (Home, Markets) + **Signals** (Intelligence,
   Smart Money) — pure regrouping, same routes.
3. Rename "Agents & Research" → **"Research"**; keep Agents/History/Research Journal/Scores.
4. Add a **"LLM & Models"** item under Settings that deep-links to
   `/dashboard/agents?tab=llm-config`. `AgentsPage` now reads `?tab=` to open that tab
   directly. This is the fix for "I can't find where to change the model."

No page component is merged in this pass. All existing routes keep working; only the
sidebar order/labels and one new deep-link change.

## Deferred (separate, larger, HIGHER RISK — needs its own approval)
- Merge Paper + Live-US + India into one **Portfolio** page with a Paper↔Live toggle
  (market driven by the global switch). Requires a new tabbed container + redirects.
- Merge Intelligence + Smart Money into one **Signals** page.
- Merge Agents + History + Research Journal + Scores into a tabbed **Research** page.
These change deep links, so they ship behind redirects in a follow-up.

## Files
- `components/dashboard/DashboardShell.tsx` — `NAV_SECTIONS` array.
- `components/dashboard/AgentsPage.tsx` — initial `tab` from `useSearchParams().get("tab")`.
