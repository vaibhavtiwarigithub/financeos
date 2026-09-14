// Role model for Shared Viewer Access (features/shared-viewer-access/FEATURE_ARCHITECTURE.md).
//
// Two roles only. `owner` is the single account that owns every row in this
// system; `viewer` is a read-only guest who owns nothing and may reach a narrow,
// explicitly listed page set.
//
// AUTHORITY. A viewer's role comes from `app_user_roles`, which only service-role
// can write. It is deliberately NOT read from `profiles.role`: that table's RLS is
// `FOR ALL USING (auth.uid() = id)`, so a signed-in user can update their own row.
// Trusting it for authorization would let any guest self-promote.

import { OWNER_EMAIL } from "@/lib/auth/owner";

export type AppRole = "owner" | "viewer";

/**
 * Pages a viewer may open. Matching is exact-or-subpath, so "/dashboard/research"
 * also admits "/dashboard/research/AAPL" but never "/dashboard/research-journal".
 */
export const VIEWER_PAGES = [
  "/dashboard/portfolio",
  "/dashboard/research",
  "/dashboard/symbol",
  "/dashboard/connections",
] as const;

/**
 * SHARED-READ routes: a viewer reading the OWNER's data.
 *
 * Every entry must be read-only over already-persisted tables — no provider
 * call, no LLM call, no write. This is the cost guarantee for shared access:
 * the tenth viewer costs what the first did. A route here that mutates or calls
 * a provider is a defect, not a configuration choice.
 *
 * Method matters: `/api/portfolio/performance-series` GET is a read, but its
 * PATCH writes the owner's saved benchmark preference, so only GET is listed.
 */
export const VIEWER_API_ROUTES: ReadonlyArray<{ prefix: string; methods: readonly string[] }> = [
  { prefix: "/api/portfolio/performance-series", methods: ["GET"] },
  { prefix: "/api/research/chart-data", methods: ["GET"] },
  { prefix: "/api/research/universe", methods: ["GET"] },
  { prefix: "/api/auth/role", methods: ["GET"] },
];

/**
 * OWN-DATA routes: a viewer acting on rows that are THEIRS.
 *
 * A separate class because connecting a broker genuinely needs to write, and to
 * call a provider — on the caller's own account, with the caller's own
 * credential. Collapsing these into the list above would have quietly weakened
 * the shared-read guarantee into "GET-only-ish", so the two are kept apart and
 * asserted separately.
 *
 * The contract for anything listed here:
 *   - writes ONLY rows keyed to the calling user
 *   - any provider call is to that user's OWN broker, on their behalf
 *   - never reads or writes the owner's data, and never a shared table
 *   - never an order path: the guest client has no order capability at all
 */
export const VIEWER_OWN_DATA_ROUTES: ReadonlyArray<{ prefix: string; methods: readonly string[] }> = [
  { prefix: "/api/broker-connections", methods: ["GET", "POST"] },
];

/** Where a viewer lands, and where they are sent when they request anything else. */
export const VIEWER_HOME = "/dashboard/portfolio";

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isViewerPage(pathname: string): boolean {
  return VIEWER_PAGES.some((page) => matchesPrefix(pathname, page));
}

/** A shared-read route: the owner's data, GET-only, no provider call. */
export function isViewerSharedReadRoute(pathname: string, method: string): boolean {
  const upper = method.toUpperCase();
  return VIEWER_API_ROUTES.some(
    (route) => matchesPrefix(pathname, route.prefix) && route.methods.includes(upper),
  );
}

/** An own-data route: the caller's own rows and their own broker. */
export function isViewerOwnDataRoute(pathname: string, method: string): boolean {
  const upper = method.toUpperCase();
  return VIEWER_OWN_DATA_ROUTES.some(
    (route) => matchesPrefix(pathname, route.prefix) && route.methods.includes(upper),
  );
}

/** Anything a viewer may call at all. */
export function isViewerApiRoute(pathname: string, method: string): boolean {
  return isViewerSharedReadRoute(pathname, method) || isViewerOwnDataRoute(pathname, method);
}

/** Owner identity is the email AND a confirmed email, matching requireOwner(). */
export function isOwnerIdentity(email: string | null | undefined, emailConfirmedAt: string | null | undefined): boolean {
  return email === OWNER_EMAIL && Boolean(emailConfirmedAt);
}

export type RoleGrantRow = { revoked_at?: string | null } | null | undefined;

/**
 * Resolve a role from identity plus an allowlist row. Pure so the precedence is
 * testable without a database: owner wins, a revoked grant is no grant, and
 * anything else is null (rejected — never a default role).
 */
export function resolveRole(
  email: string | null | undefined,
  emailConfirmedAt: string | null | undefined,
  grant: RoleGrantRow,
): AppRole | null {
  if (isOwnerIdentity(email, emailConfirmedAt)) return "owner";
  if (grant && !grant.revoked_at) return "viewer";
  return null;
}

/** What a role may do, for the owner-facing access screen. Presentation only. */
export function describeRoleAccess(role: AppRole): { pages: string[]; canEdit: boolean; notes: string } {
  if (role === "owner") {
    return { pages: ["Every page"], canEdit: true, notes: "Full access, including admin, vault, live portfolio and all write actions." };
  }
  return {
    pages: [...VIEWER_PAGES],
    canEdit: false,
    notes: "Read-only. Cannot place or close trades, run agents, change settings, or see live portfolio, risk, admin or vault.",
  };
}
