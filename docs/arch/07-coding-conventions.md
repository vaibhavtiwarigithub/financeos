# Kairos — Coding Conventions
> Last updated: 2026-07-10
> Update this file when: a project-wide convention changes, a new pattern is adopted across all files, or an existing pattern is deprecated. This chapter changes rarely.

Codified in `PRD.md` §2. All agents must follow; apply consistently to every file.

---

## 1. Styling

- **`T` token object** declared at the top of every file that renders UI:
  ```ts
  const T = {
    bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
    text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
    accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
  };
  ```
- All styles are **inline** (`style={{ ... }}`). No Tailwind utility classes.
- Color must come from `T.*` — never hard-coded hex outside the T object.
- **Mobile-first** by default: every page/component must be responsive at 375px+.
- No CSS modules. No styled-components. No class utilities of any kind.

---

## 2. Database access

| Context | Import | Notes |
|---|---|---|
| Server components / API routes | `createClient()` from `@/lib/supabase/server` | Cookie-based auth; runs server-side |
| Service role (crons, admin ops) | `createServiceClient()` from `@/lib/supabase/service` | Bypasses RLS; never use in client components |
| Client components | `createClient()` from `@/lib/supabase/client` | Browser-side; respects RLS |

Never import the service-role client in client components. The service role key must never reach the browser.

---

## 3. API route conventions

- All routes in `app/api/`. Each file exports named HTTP handlers (`GET`, `POST`, `PATCH`, `DELETE`).
- `export const dynamic = "force-dynamic"` on all routes that read runtime state.
- Auth gate: `requireOwner()` from `@/lib/auth/require-owner` on owner-only routes.
- Cron auth: `verifyCronSecret(req)` from `@/lib/auth/cron` (timing-safe comparison).
- Return `NextResponse.json({ error })` with correct HTTP status on errors.
- Cron routes: accept `x-cron-secret` header (bypasses owner session check) OR require owner session.

### Auth gate matrix

| Route type | Gate |
|---|---|
| `/dashboard/**` pages | Supabase middleware (redirects to login) |
| `/api/**` routes | Each route calls `requireOwner()` itself — middleware does NOT cover API routes |
| Cron routes | Accept `x-cron-secret` header OR require owner session |
| Admin routes | `requireOwner()` + role check |

---

## 4. Agent conventions

- All agents write to shared Supabase tables. **Zero direct agent-to-agent HTTP calls.**
- Every agent run logs to `agent_runs` (start/end/status). Log before any external call.
- LLM calls go through `callLLM()` in `lib/llm-router.ts` (Langfuse tracing + cost logging).
- Multi-step tool loops use `runAgentLoop()` (also Langfuse-traced).
- Scores are deterministic (no LLM). Thesis/direction text comes from `fast` (Groq).
- Use tier aliases (`fast`, `claude-smart`, `claude-opus`, etc.) — never hardcode model names in agent files.

---

## 5. TypeScript

- Strict mode always on.
- Centralized types at `@/types/` — add new shared types there, not inline in route files.
- No `any` outside of tightly-scoped third-party type bridging.
- All API response shapes typed.

---

## 6. File structure

```
app/
  api/
    agents/<name>/route.ts    — agent endpoint
    briefing/generate/route.ts
    admin/route.ts
    ...
  dashboard/<page>/page.tsx   — dashboard pages
components/
  dashboard/                  — dashboard components
  ui/                         — shared UI primitives
lib/
  supabase/
    server.ts                 — cookie client
    client.ts                 — browser client
    service.ts                — service role client
  llm-router.ts
  vault.ts
  av-cache.ts
  research-agent.ts
  providers/
    embeddings/
    rerank/
    email/
  brokers/
    adapters/
    registry.ts
```

---

## 7. What never to do

1. **Never re-litigate approved decisions.** If it's in `PROJECT_DECISIONS.md` as approved → implement it, don't redesign it.
2. **Never invent styling conventions.** Inline styles with `T` color tokens only.
3. **Never use Tailwind utility classes.** The codebase does not use them.
4. **Never touch the primary Robinhood account.** Agentic account only (see `08-risk-and-safety.md`).
5. **Never add features beyond the current task scope.** No scope creep.
6. **Never commit secrets.** No API keys, no tokens, no service role keys in code.
7. **Never modify `AGENTS.md` or `PRD.md` without Architect role + Vaibhav approval.**
8. **Never call agent endpoints from other agent endpoints.** Table-mediated coordination only.
