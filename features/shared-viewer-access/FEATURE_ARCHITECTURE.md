# Feature Architecture: Shared Viewer Access (Read-Only Friends & Family)

## Status

Architecture status: Approved
Architecture approved: Yes (owner, 2026-09-14)
Approved scope: Phases 0-3 mechanism. The DECISION to invite any given person
stays the owner's, taken in the app.
Approved date: 2026-09-14
Implementation allowed: Phases 0-3

**Phase 0 status: APPLIED AND VERIFIED IN PRODUCTION, 2026-09-14** —
`supabase/migrations/20260914140000_viewer_phase0_close_blanket_rls.sql`.
34 blanket-authenticated policies replaced by owner-pinned reads; post-state
0 open, 91 owner-pinned, RLS on 213/213 tables. No viewer role, allowlist, or
invitation exists. See Decision 76.

**Phases 1-3 status: IMPLEMENTED, 2026-09-15** — `app_user_roles` is the
sole non-owner authority; middleware and each viewer-safe handler enforce the
same allowlist; owner-only `/dashboard/admin/access` can invite, resend a
single-use access link, revoke (with a notice), restore, and permanently delete
a viewer account. Delete first revokes, then removes the `auth.users` identity
(cascading its grant); a typed `DELETE <email>` confirmation is required. Mail
delivery is explicitly reported rather than assumed. A delivery failure never
undoes a revocation or misreports a sent notice.

The authorization controls, not the UI, are the boundary: the server resolves
viewer grants on every request, viewer routes enforce `requireViewerOrOwner`,
and direct PostgREST reads remain owner-pinned by RLS. `tests/viewer-route-sweep.test.ts`
asserts both route allowlisting and handler gates so a future route cannot become
viewer-reachable merely because its navigation is hidden.

Related designs: `features/per-user-broker-risk/FEATURE_ARCHITECTURE.md` (draft,
unapproved) builds on this one — it gives a guest their own broker connection and
private risk analytics, which is the first time a non-owner owns rows. It
deliberately does NOT change anything here: viewers stay read-only over the
owner's data, and the private plane lives in separate tables.

Relationship to `features/multi-tenant/FEATURE_ARCHITECTURE.md`: that document
designs full per-user tenancy (own book, own broker, own genome, per-user
learning). It is **deferred, not cancelled**. This document is the smaller,
nearer-term path the owner chose on 2026-09-14 and is the only one proposed for
implementation. They are not competing designs: this one ships first and does
not preclude the other.

---

## Feature Purpose

Let the owner give a small, named circle (friends & family) a **read-only window**
into Kairos: how the paper portfolio is doing, and what the research/fundamentals
view says. Viewers sign in with their own email. They get no book, no broker
connection, no agent, and no ability to change anything.

The design goal is not "multi-user Kairos". It is "a shareable view of the
owner's single-user Kairos", with the cheapest possible blast radius.

## User/System Questions This Feature Answers

- How does the owner let a specific person see the app without giving them an
  account that owns data?
- What exactly can a viewer see, and what is provably out of reach?
- How do we guarantee that adding viewers does not multiply API/LLM cost?
- What stops a viewer bypassing the UI and reading the database directly?

## Scope

- A two-role model: `owner` (unchanged, full access) and `viewer` (read-only,
  narrow page set), backed by a server-side allowlist.
- Page and API route gating for the viewer role.
- An RLS lockdown of the tables currently reachable by any authenticated user.
- A viewer-reachable-route audit whose pass condition is: no route a viewer can
  reach may cause a provider or LLM call.
- Acceptance tests including negative tests issued directly against PostgREST,
  not through the UI.

## Non-Goals (explicitly OUT of scope)

- **Any per-user data.** Viewers own no rows. No viewer book, no viewer
  watchlist, no viewer settings beyond session.
- **Any broker connection for a viewer**, read-only or otherwise.
- **Any write path for a viewer**, including paper trades, approvals, queue
  actions, or strategy edits.
- **Any per-user agent, research run, genome, or learning.** Explicitly: no
  per-user cron fan-out. This is the cost guarantee and it is load-bearing.
- Live portfolio, live risk analytics, broker orders, admin, vault, system
  health, and cost/LLM telemetry are owner-only and stay owner-only.
- Billing, public signup, self-service invitation.

---

## Current Behavior (verified against production + code, 2026-09-14)

Kairos is single-user, gated on one hardcoded email.

| Layer | Today | Evidence |
|---|---|---|
| Identity | `OWNER_EMAIL = "vterminater@gmail.com"` | `lib/auth/owner.ts` |
| Page gate | middleware rejects any non-owner session | `middleware.ts` (matches `/dashboard`, `/property`, `/admin` only — **not** `/api/*`) |
| API gate | `requireOwner()` per route | 169 of 252 API routes call it; the remainder use cron secrets or inline `ADMIN_EMAIL` checks |
| Data reads | server-side `createServiceClient()` | 266 files; service-role **bypasses RLS entirely** |
| RLS | enabled on 213/213 public tables | but only 21 tables have any owner column |

### The load-bearing observation

Dashboard pages are **server-rendered and read through the service-role client**
(e.g. `app/dashboard/portfolio/page.tsx`). RLS is therefore *not* the delivery
mechanism for anything a user sees — the server fetches, the server filters, the
page renders.

Two consequences, and they set the whole design:

1. **Viewers need zero direct table access.** Everything they see arrives
   server-rendered. So the RLS task is to *close* doors, never to open new ones
   for the viewer role.
2. **RLS is the only thing standing between a viewer and the raw database.**
   `lib/supabase/client.ts` uses `NEXT_PUBLIC_SUPABASE_ANON_KEY`, so the anon key
   ships to the browser. Any holder of a valid session can query PostgREST
   directly. **The UI is not a security boundary.**

### What a viewer could reach today, if admitted with no other change

RLS policies keyed on `auth.role() = 'authenticated'` or `USING (true)` do not
distinguish an owner from a viewer. Verified in production:

**Read *and write* by any authenticated user** (7 tables) — policy `FOR ALL`:
`paper_portfolio`, `paper_positions`, `paper_performance`, `agent_signals`,
`research_packets`, `learning_log`, `signal_weights`.

**Read by any authenticated user** (27 tables), including owner-private data:
`live_position_state`, `agentic_position_ledger`, `live_exit_ladder_shadow`,
`trade_log`, `trade_queue`, `security_events`, `llm_call_log`, `agent_runs`,
`agent_alerts`, `agent_memory`, `briefings`, `newsletters`, `readiness_controls`,
`readiness_runs`, `risk_analytics_cache`, `signal_score_history`,
`strategy_classifications`, `strategy_templates`, `paper_nav_history`,
`price_cache`, `symbol_profiles`, `india_market_snapshot`, `earnings_calendar`,
`earnings_consensus_snapshots`, `instrument_family_observations`,
`sector_breadth_history`, `announcements`.

So a "read-only viewer" would in fact hold **write access to the paper book and
the learner's weights**, and **read access to live position state** — none of it
visible in, or caused by, the UI.

This is not a live breach today: no non-owner can obtain a session. It is a
control with exactly one user's worth of margin, and this feature spends it.

### What is already correct

| Group | Status |
|---|---|
| 72 tables pinned to the owner's email | correct — viewers blocked, no change needed |
| ~10 tables scoped to `auth.uid()` | correct |
| `broker_*`, `api_key_vault`, `live_account_snapshots`, `app_settings`, `decision_observations` | RLS on with **no policy** = deny-all to non-service-role. Correct |

### Browser-side query surface (constrains the lockdown)

Only three components query Supabase from the browser, touching six tables:

| File | Tables |
|---|---|
| `components/dashboard/DashboardShell.tsx` | `strategy_config`, `trade_proposals` |
| `app/dashboard/intelligence/page.tsx` | `newsletters`, `profiles` |
| `app/dashboard/settings/page.tsx` | `profiles`, `strategy_versions` |

`DashboardShell` wraps every dashboard page including the viewer's. `strategy_config`
is already owner-email-pinned, so a viewer's browser query returns an empty set
rather than an error — the shell should degrade, not break. **This must be
verified, not assumed**, and is an acceptance test below.

---

## Proposed Behavior

### 1. Roles and identity

Two roles: `owner` and `viewer`. Owner behaviour is unchanged.

- Identity resolves **server-side** from a stored allowlist keyed on the Supabase
  `auth.users.id`, not on an email string alone and not on any user-editable
  profile field. Email remains the invitation address; the user ID is the
  authority once the account exists.
- A viewer cannot change their own role. Role is owner-managed only.
- Revocation must terminate access at the **API and RLS layers**, not merely hide
  navigation.
- Invitation uses Supabase's server-side invite so the recipient sets their own
  password. No owner-chosen password is ever transmitted, stored, or logged.

`OWNER_EMAIL` stays the definition of owner; the allowlist is additive and only
ever grants the strictly weaker `viewer` role.

### 2. What a viewer sees

Exactly two areas:

- **Paper Portfolio** — the owner's paper book: NAV, positions, trades,
  performance vs benchmark. Labelled unambiguously as the owner's book, so no
  viewer reads it as their own performance.
- **Research / fundamentals** — the research view and symbol fundamentals.

Everything else returns 403 for a viewer: live portfolio, risk, admin, vault,
settings, agents, system health, learning, upgrade path, trading, property,
capital.

### 3. RLS lockdown (the core change)

Because viewers need no direct table access, the change is a strict narrowing:

1. **Remove write access** from the 7 `FOR ALL` tables. Writes belong to
   service-role only. This is correct regardless of this feature — nothing in the
   app writes to those tables from the browser.
2. **Remove the blanket `authenticated` SELECT** from the 27 read-open tables,
   leaving service-role (and owner-pinned where one already exists).
3. **Add no new viewer-readable policy.** If a viewer can reach a table directly,
   that is a design error, not a feature.

Net effect: a viewer's session grants access to nothing in PostgREST. All viewer
data arrives server-rendered through role-checked pages.

Ordering note: this step is independently valuable and carries **zero invitation
risk**. It should ship and soak *before* any viewer account exists.

### 4. Route gating and the cost rule

- Extend `middleware.ts` to resolve role and restrict viewers to the permitted
  page set.
- `requireOwner()` stays on every route that is not explicitly viewer-safe. A new
  `requireViewerOrOwner()` guards only the handful of read endpoints backing the
  two viewer pages.
- **Viewer-reachable-route sweep (pass condition for launch):** every route a
  viewer can reach must be read-only over already-persisted tables. No route a
  viewer can reach may call a market-data provider, an LLM, or a broker. The 83
  routes not currently calling `requireOwner` are the audit population.

### 5. Cost model

Adding viewers costs **nothing per viewer** in provider spend:

- No per-user crons. The 96 active pg_cron jobs stay singular.
- No per-user research, scoring, or LLM calls.
- Viewers read rows that already exist; the tenth viewer costs what the first did.

The cost risk is **not** viewer count — it is a single viewer-reachable endpoint
that triggers a provider call. Rule 4 above is the entire mitigation. This matters
because Alpha Vantage usage already exceeds the code default (35–71 calls/day
observed against a default of 25); a viewer-triggered research path would compound
an existing overrun.

---

## Phased Rollout

| Phase | Content | Gate to next |
|---|---|---|
| 0 | **DONE 2026-09-14.** RLS lockdown (§3) only. No role, no allowlist, no invitation. | Owner's own usage unaffected for one full session cycle; no route regressions |
| 1 | **DONE 2026-09-14.** Role + allowlist + middleware/page gating + viewer-safe API guards | Isolation matrix passes (below) |
| 2 | **DONE 2026-09-14.** Viewer-reachable-route sweep (§4) | Zero viewer-reachable provider/LLM paths |
| 3 | **DONE 2026-09-14 (mechanism).** Owner-triggered invitation from `/dashboard/admin/access` | — |

**Phase 3 is a capability, not an act.** The invite button exists; no invitation
has been sent and none will be sent by anyone but the owner, from the app. That
placement is deliberate: the open regulatory question below is a judgement about
a specific person and what they will do with what they see, so the decision sits
with the owner at the moment of inviting, not in a deployment.

Mechanics: the recipient receives a Supabase invitation email and sets their own
password — no password is accepted, generated, stored, logged or returned. Access
comes from the `app_user_roles` row, not from the auth user, so a half-completed
invite fails closed: they can sign in and reach nothing. Re-inviting a previously
revoked person reuses their account and restores the grant rather than erroring.

No phase may be skipped, and Phase 3 requires Phases 0–2 verified in production,
not locally.

## Acceptance Tests

Negative tests must be issued **directly against PostgREST with a viewer JWT**,
never through the UI — the UI is not the boundary being tested.

1. With a viewer session token, a direct PostgREST `SELECT` on each of the 34
   previously-open tables returns empty or 401/403.
2. With a viewer session token, a direct PostgREST `INSERT`/`UPDATE`/`DELETE` on
   `paper_portfolio`, `paper_positions`, `paper_performance`, `agent_signals`,
   `research_packets`, `learning_log`, `signal_weights` fails.
3. A viewer requesting any owner-only page or API route receives 403.
4. A viewer can load Paper Portfolio and the research view, and the rendered data
   matches the owner's view.
5. `DashboardShell` renders for a viewer without error despite its browser-side
   `strategy_config` / `trade_proposals` queries returning empty.
6. No route reachable by a viewer issues a provider or LLM call — asserted by
   `llm_call_log` and provider-call audit rows being unchanged across a full
   viewer session.
7. Owner behaviour is byte-identical before and after: paper book, live
   portfolio, agents, crons all unchanged.
8. A revoked viewer is denied at the API layer, not merely at navigation.
9. Full suite, typecheck, production build.

## Open Decisions (for the owner)

1. **Regulatory.** Showing research and signals to people who may trade their own
   money on them is materially different from showing them a performance chart.
   India (SEBI research-analyst rules) is the sharper exposure. This is not
   resolvable in code and is not a claim this document adjudicates — it is flagged
   as a gate to clear outside the repository. A paper-performance-only viewer
   (dropping the research page) materially reduces it.
2. **Does the viewer page set include research at all**, or only Paper Portfolio?
   Decision 1 may answer this.
3. **Allowlist storage** — a new owner-managed table vs an env var. A table allows
   revocation without redeploy; an env var is simpler and harder to tamper with.
4. **Attribution labelling** — exact wording that makes clear the book is the
   owner's, not the viewer's.

## Update triggers (per CLAUDE.md)

If approved and implemented, the SAME change must update:
`docs/arch/04-database-schema.md` (RLS policy changes),
`docs/arch/07-coding-conventions.md` (role gating + the viewer-route cost rule),
`docs/arch/08-risk-and-safety.md` (viewer lockout boundary),
and `PROJECT_DECISIONS.md` (a decision record for the two-role model).
`05-crons-and-scheduling.md` is explicitly NOT updated: this feature adds no cron
and no fan-out, and that absence is the cost guarantee.


---

## Phase 1-2 as built (2026-09-14)

### Viewer page set, and why the rest are excluded

| Page | Verdict | Reason |
|---|---|---|
| `/dashboard/portfolio` | **included** | Server-rendered from the database only |
| `/dashboard/research` (Fundamentals) | **included** | `/api/research/{chart-data,universe}` are pure DB reads — zero outbound calls |
| `/dashboard/symbol/[symbol]` | **included** | Reads `agent_signals` + `paper_trades` only; without it every symbol link on the portfolio page 403s |
| `/dashboard` (Home) | excluded | Reads `live_account_snapshots` — owner's real broker data |
| `/dashboard/markets` | excluded **for now** | Calls Massive. NOT per load — corrected 2026-09-14, see below |
| `/dashboard/calendar` | **safe to include** | `/api/calendar/earnings` already has a 24h DB TTL — corrected 2026-09-14, see below |
| `/dashboard/scanner` | excluded | Screener endpoints call providers |
| everything else | excluded | Owner-private: live portfolio, risk, agents, learning, admin, vault, settings, trading |

### Correction (2026-09-14): these endpoints are already cached

An earlier revision of this document claimed Markets and Calendar "call a
provider on every page load". That was **wrong**, and it is recorded here rather
than quietly edited away because it changed an exclusion decision.

| Endpoint | Actual caching |
|---|---|
| `/api/calendar/earnings` | **24h DB TTL** against `earnings_calendar.fetched_at` — already once a day |
| `/api/markets/overview` | `export const revalidate = 300`, a 5-minute in-memory cache, `next: { revalidate: 3600 }` on the grouped fetch, and an immutable per-date session cache |
| `/api/markets/quotes` | `next: { revalidate: 300 }` per symbol |

So Calendar meets the once-a-day bar today and may be included. Markets stays
excluded for a different and better reason: it serves **daily data on a
five-minute refresh cycle**. `/api/markets/quotes` calls Massive's `/prev`
endpoint — the previous day's close — and `/api/markets/overview` uses grouped
*daily* bars whose closes its own comment calls immutable. Up to ~288 refresh
windows a day for values that change once.

The fix is to match cadence to the data, which India already does
(`kairos-india-markets-fill` warms `india_market_snapshot` at 10:15 UTC and the
page reads the table). US has no equivalent and computes on demand. Giving US
the same treatment removes provider calls from the page load entirely, which
also makes Markets viewer-safe. That is separate, approval-gated work — a new
cron plus a snapshot table plus a route rewrite, not a list edit.

### Two owner-private leaks found and closed while building

1. **`/api/research/universe` returned `broker_orders`** — the owner's real money
   orders (side, qty, fill price, status), merged into the Fundamentals page. The
   query is now skipped by role rather than filtered after the fact, so a viewer's
   response is built without ever reading the table.
2. **`profiles.role` was self-writable.** Its RLS is `FOR ALL USING (auth.uid() = id)`
   with no `WITH CHECK`, and `middleware.ts` gated `/admin` on
   `profiles.role in ('admin','superadmin')` — a self-promotion path to `/admin`
   the moment a second account existed. Now: a DB trigger rejects any client-side
   change to `role`, and `/admin` gates on owner identity instead.

### Authority and revocation

- A viewer's role comes only from `app_user_roles` (service-role write only), never
  from `profiles`.
- Revocation sets `revoked_at`; the row is kept so grant history survives.
  Middleware re-reads the grant on **every** request, so revocation stops the
  session at the edge and at every viewer-safe route — not merely in navigation.
- `app_user_roles` has two read policies: owner reads all, and a viewer reads only
  their own row (`user_id = auth.uid()`). Without the self-read, middleware — which
  runs on the caller's session, not service-role — resolves no grant and signs the
  viewer straight back out.

### Owner-facing controls

`/dashboard/admin/access` (owner-only) lists every grant, what each role may view
and edit, and provides revoke/restore. Backed by `/api/admin/access`.

### Phase 2 enforcement

`tests/viewer-route-sweep.test.ts` fails the build if any viewer-reachable route
gains an outbound call or a provider/broker/LLM import. It also asserts the
calendar and analytics helpers on the viewer read path stay **synchronous** — a
synchronous function cannot await a network call, which proves the path cannot
reach `fetchMarketStatuses` inside `market-calendar.ts`.

---

## Invitation lifecycle correctness (2026-09-15, owner-approved "fix all")

### The defect

Three questions the owner asks of the access page had been collapsed into one
green **"Active"**, because the only fact the page carried was
`active = !revoked_at`:

1. They accepted the invitation and can sign in.
2. The invitation was sent and is sitting unopened.
3. The invitation **bounced**. Nobody received it and nobody ever will.

(3) is why this matters. Nothing in the chain could detect it:

- `generateLink` creates an `auth.users` row for any address matching the
  route's syntax check. It does not verify the mailbox exists.
- Resend returns success when it **accepts** a message. A dead mailbox bounces
  asynchronously, minutes later, reported only by webhook — which the app did
  not consume.

So a mistyped address produced an orphan auth user plus a grant the owner's own
screen reported as active access. The access itself was inert (no link, no
session), but the page whose entire job is answering *"who can see my book?"*
was giving the wrong answer.

### Three cases, as verified against the code and production

| Case | Behaviour | Status |
|---|---|---|
| Invite the same address twice | `findUserByEmail` → `returning=true` → **recovery** link (Supabase refuses to re-invite an existing account). Grant is `upsert(onConflict: "user_id")` on the PK, so one row is updated, never duplicated. | Correct before this change |
| Revoke, then invite again | Same path; the upsert explicitly writes `revoked_at: null, revoked_by: null`. Their existing password still works. | Correct before this change |
| Address does not exist | Grant written on provider acceptance, rendered "Active" forever. | **Fixed here** |

### Design

**Acceptance and deliverability are separate axes and are deliberately not
merged into one enum.**

- **Acceptance** is `auth.users.confirmed_at`, *read* by the GET handler and
  never mirrored into `app_user_roles`. Supabase owns that fact; a copy would
  go stale the moment someone accepts.
- **Deliverability** is the new `undeliverable_*` columns, written only by the
  Resend webhook.

Collapsing them would introduce a second lie in the opposite direction: a guest
who already uses the app daily would look locked out the day their mailbox
fills up. `lib/auth/grant-status.ts` is the single derivation, shared by the
API, the page, and the tests.

**Deliverability NEVER gates access.** A bounce is a fact about a mailbox, not a
judgement about a person. Revocation stays the owner's deliberate act.

### The webhook is a public endpoint, so it fails closed

`POST /api/webhooks/resend` must be public — Resend calls it — and what it
writes is read by the owner as "can this person be reached". Therefore:

- Every request is Svix signature-verified against `RESEND_WEBHOOK_SECRET`,
  over the **raw bytes**, before the body is parsed. No secret, missing headers,
  wrong signature, or a timestamp outside ±5 minutes → 401, nothing written.
  **There is no verification-skip flag**, because that flag is the bug.
- It can write **only** the three `undeliverable_*` columns. It cannot insert,
  cannot upsert, cannot touch `role`, `granted_by`, `revoked_at`, or
  `revoked_by`. An unverified public endpoint that could change who signs in
  would be handing a stranger the access controls.
- Transient bounces (full mailbox, greylisting) are ignored — they clear on
  their own, and flagging them would put a red warning on a grant that is fine
  by morning.
- A recipient with no grant row (the owner's own newsletter) is a silent no-op.

### Residual risk, stated rather than solved

A typo landing on a domain **someone else controls** means that person receives
a working set-password link and becomes a viewer. That is inherent to email
invitation and is not fixed here. What this change does is make it *visible*:
such an invite shows as "Invited — not yet accepted" until used, and the owner
can revoke it. Shortening the link's validity is a separate decision, not taken.

### Acceptance tests

`tests/invite-delivery-state.test.ts` — 22 assertions, all 12 mutations in the
harness caught, including: pending rendered as active, a bounce rendered as
active, a post-acceptance bounce removing access, a dev bypass on the missing
secret, dropped replay tolerance, an always-true signature compare, the webhook
gaining insert/upsert or touching `revoked_at`, parsing before verifying, and
the page reverting to counting un-revoked rows.

## Email links and delivery truth (2026-09-15, owner-approved "fix only the login issues")

### Defect 1 — an invite link changed the owner's password

Observed in production: the owner opened a viewer's invitation in a browser
still signed in as the owner, chose a password, and it was written to the
OWNER's account ("New password should be different from the old password" on a
retry confirmed it). The viewer's account never received a password, so it
could not sign in.

Cause, two parts together:

1. The route mailed Supabase's `action_link`, which returns tokens in the URL
   hash. The PKCE browser client from `@supabase/ssr` does not read hash tokens,
   so opening the link never replaced the owner's session.
2. `/reset-password` showed its form whenever `getSession()` returned any
   session and then called `updateUser({ password })` on it.

Fix (`lib/auth/email-link.ts`, `app/reset-password/page.tsx`,
`app/auth/confirm/page.tsx`, `app/api/admin/access/route.ts`):

- Invitation and recovery emails link to `/reset-password?token_hash=…&type=…`,
  built from `generateLink().properties.hashed_token`. The owner's "Resend
  email" sign-in link goes to `/auth/confirm?token_hash=…&type=magiclink&next=/dashboard/portfolio`.
- Both pages verify the link themselves (`verifyOtp`; also a PKCE `code`, and
  Supabase's hash tokens via `setSession` so the login page's Supabase-sent
  "Forgot password" mail keeps working). Verifying replaces whatever session
  the browser had. No link, an expired link, or a link of the wrong type is an
  error; an existing session is never a fallback.
- `/reset-password` shows "for <email>", strips the token from the address bar,
  and re-checks `getUser().id` against the link's account immediately before
  `updateUser`.
- A sign-in link cannot set a password and a recovery link cannot be used as a
  plain sign-in link.

Residual: opening a viewer's link in the owner's browser now signs that browser
in as the viewer (the correct account), which signs the owner out there.

### Defect 2 — "the notice email sent" when it was only accepted

A deletion notice was accepted by Resend and landed in the recipient's spam
folder while the page said it was sent. The message id was discarded, and the
grant row that could have held a status is cascade-deleted with the account.

Fix: `access_email_notices` (migration `20260915220000`, applied and verified in
production). The route records every accepted invitation, sign-in link, revoke
and delete notice by Resend message id; the webhook updates its status by id
before looking for a grant (update only, never insert). The access page words
the result as "accepted for delivery" and lists recent access emails with
status: accepted, delivered to their mail server, bounced, reported as spam by
recipient. It states plainly that a spam-folder placement is invisible and
shows as delivered.

Not fixable in code: mail from Resend's shared `onboarding@resend.dev` sender
is often filtered to spam and may only be sent to the Resend account owner.
A verified sending domain plus `EMAIL_FROM` is the owner's decision.

### Acceptance tests

`tests/email-link-session.test.ts` (link parsing, session establishment,
type restrictions, open-redirect guard, and source guards on both pages and the
route) and `tests/access-email-notices.test.ts` (id recorded for all four email
kinds, webhook update order, RLS with no policy, page never overclaims).
