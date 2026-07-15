# Feature Architecture: Stock Context

## Status

Architecture status: Draft
Architecture approved: Yes (owner: "build it"; Codex endorsed peers-context-only)
Approved scope: Read-only "what is this stock" context layer, off the money path
Approved date: 2026-07-15
Implementation allowed: Yes

## Feature Purpose

Research and watchlist screens currently show bare tickers (`RELIANCE.NS`, `NVDA`)
with no plain-language answer to "what is this company and why am I looking at it?".
Stock Context adds a lightweight, cached, display-only profile layer: company name,
a one-sentence "what it does", sector/industry, exchange, market-cap tier, next
earnings date, and up to a few peer tickers shown as **context chips** (never
clickable trades). It also surfaces a short "why revisit + when" reason derived
from data the app already holds.

This is orientation only. It never scores, sizes, gates, or orders anything.

## User/System Questions This Feature Answers

- What is this company, in one sentence?
- What sector / industry / exchange is it, and roughly how big (mega/large/mid/small/micro)?
- When does it next report earnings?
- Who are a few peers (for context — NOT trade suggestions)?
- Why is this symbol in my queue/watchlist, and when should I look again?

## Scope

This feature includes:
- A `symbol_profiles` cache table (per `(symbol, market)`), RLS-locked.
- `lib/data/symbol-profile.ts` — fetch + cache one symbol's profile (FREE providers only).
- `app/api/agents/symbol-profiles/backfill/route.ts` — owner/cron-gated, bounded backfill for watchlist symbols missing a fresh (<30d) profile; also backfills `watchlist.company_name` where null.
- `lib/revisit-reason.ts` — pure function: short "why revisit + when" string from existing row data.
- `app/api/symbol-profile/route.ts` — owner-gated GET returning the cached profile + revisit reason.
- `components/dashboard/StockContextStrip.tsx` — mobile-first display strip.
- Wiring the strip into the symbol detail page.

## Non-Goals

This feature does not include:
- Any LLM call anywhere (the one-liner is composed deterministically).
- Any import by scoring / sizing / gating / order code (off the money path — hard invariant).
- Clickable peers or peer-driven navigation into trades. Peers are inert context chips.
- Live price/quote (that already exists elsewhere on the detail page).
- Paid data providers. FREE tier only (Finnhub free, Yahoo auth-free/crumb).
- Mixing per-market data or per-currency values.

## Current Behavior

Research/watchlist rows render the ticker string and, where present,
`watchlist.company_name` (often null). No sector/industry/earnings/peers context.

## Proposed Behavior

1. A backfill job (owner-triggered or cron) fills `symbol_profiles` for watchlist
   symbols that lack a profile fresher than 30 days, bounded by a wall-clock budget
   so it never blows Vercel `maxDuration`. It also copies the fetched company name
   into `watchlist.company_name` when that column is null.
2. The symbol detail page reads the cached profile + a computed revisit reason via
   an owner-gated GET route and renders `StockContextStrip`.
3. If no profile is cached yet, the strip renders nothing (graceful empty state) —
   the page is fully functional without it.

## User Journey / System Flow

1. Owner opens `/dashboard/symbol/NVDA`.
2. Page server-fetches signals/trades (existing) and passes `symbol` + `market` to the client.
3. `StockContextStrip` calls `GET /api/symbol-profile?symbol=NVDA&market=us`.
4. Route (owner-gated) reads `symbol_profiles` cache + computes revisit reason, returns JSON.
5. Strip renders: name · one-liner · sector · exchange · mkt-cap tier · next earnings · peer chips · revisit reason.

## Screen / Page / Module Inventory

- Table: `symbol_profiles` (cache).
- Module: `lib/data/symbol-profile.ts` (fetch+cache; US Finnhub, India Yahoo).
- Module: `lib/revisit-reason.ts` (pure).
- Route: `POST /api/agents/symbol-profiles/backfill` (owner/cron-gated, bounded).
- Route: `GET /api/symbol-profile` (owner-gated read).
- Component: `components/dashboard/StockContextStrip.tsx`.
- Wiring: `app/dashboard/symbol/[symbol]/page.tsx`.

## UI Architecture

### Layout
A single horizontal strip above the tab bar on the symbol detail page. On mobile it
wraps to multiple rows; each datum is a labeled inline chip. Peer tickers render as a
small chip row labeled "Peers (context)".

### Components
`StockContextStrip` (client). Fetches its own data; renders nothing while loading or
when no profile exists. Uses the existing `T` token palette + `clamp()` responsive sizing.

### Sheets / Modals / Drawers
None.

### Navigation
None changed. Peer chips are NOT links and do not navigate.

### Empty State
Renders nothing (null) — the rest of the page is unaffected.

### Loading State
Renders nothing (null) until the fetch resolves — avoids layout jitter for a
secondary, non-blocking strip.

### Error State
On fetch error the strip renders nothing (fail-soft; this is context, not critical).

### Success State
Full strip with all available fields; missing fields are omitted, not shown as "—".

## System Architecture

### Modules
- `symbol-profile.ts` — `getSymbolProfile(symbol, market, svc)` returns the cached row
  if fresh (<30d), else fetches + upserts + returns. `fetchSymbolProfile()` composes
  the profile from free providers. `oneLinerFrom()` builds the deterministic sentence.
  `capTierFrom()` maps market-cap (USD millions) to a tier.
- `revisit-reason.ts` — `computeRevisitReason(input)` pure; no I/O.

### API Contracts
- `GET /api/symbol-profile?symbol=<sym>&market=us|india` → `{ profile: SymbolProfile | null, revisit: { reason, urgency } | null }`. Owner-gated (401/403 otherwise).
- `POST /api/agents/symbol-profiles/backfill?market=us|india&limit=<n>` (owner OR `x-cron-secret`) → `{ processed, filled, watchlistNamesBackfilled, skippedFresh, deferred }`.

### Data Models
`symbol_profiles`:
- `symbol text`, `market text` (`us|india`), `company_name text`, `one_liner text`,
  `sector text`, `industry text`, `exchange text`, `market_cap_tier text`
  (`mega|large|mid|small|micro`), `next_earnings_date date`, `peers text[]`,
  `source text`, `updated_at timestamptz`. PK `(symbol, market)`.

### Auth / Permissions
- Table: RLS ENABLED. Policy: `for select to authenticated using (true)` — anon denied,
  owner (authenticated) can read, service_role writes via bypass. (New public tables
  with RLS off are a Security Advisor ERROR — this table ships RLS-on from migration 1.)
- Read route: `requireOwner()`.
- Backfill route: `requireOwner()` OR `verifyCronSecret()` (service-to-service).

### Error Handling
Every external fetch is wrapped and fail-soft: a provider miss yields a partial or
null profile, never a thrown error. India peers/earnings are best-effort (often null).

## Data Architecture

- Required data: `symbol`, `market`.
- Optional data: everything else (all nullable; store what the provider returns).
- Mock vs real vs derived: real (Finnhub/Yahoo) + derived (`one_liner`, `market_cap_tier`).
- Persistence: `symbol_profiles`, refreshed when older than 30 days.
- Validation: `market` constrained to `us|india`; `market_cap_tier` constrained to the 5 tiers.

## Providers (FREE only)

- **US**: Finnhub `/stock/profile2` (name, finnhubIndustry→sector, exchange,
  marketCapitalization→tier), `/stock/peers` (peers), `/calendar/earnings`
  (next earnings date). Finnhub free = 60/min, no daily cap.
- **India** (`.NS`/`.BO`): Yahoo (auth-free chart + crumbed quoteSummary, reused from
  `lib/india-data.ts`) for name/sector/industry/market-cap/exchange, and
  `fetchIndiaEarningsDate` for next earnings. Peers are unavailable for free on India —
  stored as `[]`/null (best-effort, acceptable).

## Off-Money-Path Guarantee

`lib/data/symbol-profile.ts`, `lib/revisit-reason.ts`, `StockContextStrip.tsx`, and both
routes are display-only. They are NEVER imported by scoring/sizing/gate/order code
(`lib/research-agent`, `lib/scoring/*`, `lib/data/scores.ts`, paper-trade/trader routes).
Import direction is one-way: this feature imports existing helpers; nothing on the money
path imports this feature. Deterministic — no LLM is invoked anywhere in this feature.

## Per-Market Handling

`market` is a first-class key (`(symbol, market)` PK). US and India never share a row.
India profiles are Yahoo-sourced with best-effort peers/earnings; US profiles are
Finnhub-sourced. No per-currency numeric values are stored (tier is a categorical label),
so no currency mixing is possible.

## Peers-Context-Only Rule

Peers are stored as `text[]` and rendered as inert chips under a "Peers (context)" label.
They are NEVER clickable, NEVER navigated to, and NEVER fed into scoring, screening,
candidate generation, or any candidate list. This is a hard boundary Codex endorsed.

## Files Likely To Change

- `features/stock-context/FEATURE_ARCHITECTURE.md` (this file)
- `supabase/migrations/20260715150000_symbol_profiles.sql` (new)
- `lib/data/symbol-profile.ts` (new)
- `lib/revisit-reason.ts` (new)
- `tests/revisit-reason.test.ts` (new)
- `app/api/agents/symbol-profiles/backfill/route.ts` (new)
- `app/api/symbol-profile/route.ts` (new)
- `components/dashboard/StockContextStrip.tsx` (new)
- `app/dashboard/symbol/[symbol]/page.tsx` (wire strip)
- `lib/india-data.ts` (additive: expose name/market-cap/exchange from the Yahoo overview)

## Files / Behavior That Must Not Change

- Scoring / sizing / gate / order code — must not import this feature.
- `computeScores`, `research-agent`, `paper-trade`, `trader` — untouched.
- Peer navigation — must remain absent.

## Acceptance Criteria

- `symbol_profiles` exists in prod with RLS on and an authenticated SELECT policy (verified).
- `getSymbolProfile` returns a cached row and refreshes when >30d old.
- No LLM call in any file of this feature.
- No scoring/order module imports this feature.
- Backfill is idempotent, bounded by a wall-clock budget, and backfills `watchlist.company_name`.
- Strip is responsive (mobile-first) and renders peers as non-clickable chips.
- `tsc --noEmit`, `npm run build`, `vitest run` all pass.

## Approval

Architecture approved: Yes
Approved scope: As above (peers-context-only, off money path)
Implementation allowed: Yes
