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
  // NOT "/dashboard/risk" — that is the OWNER's Daily Per-Holding Risk
  // dashboard over the owner's live account book. The guest page is its own
  // path so a viewer cannot reach the owner's book.
  "/dashboard/my-risk",
  // Research → Daily Funnel and Score Tracker tabs only (the page hides the
  // other tabs for viewers). NOT "/dashboard/markets": nearly every panel there
  // calls a provider, one reads the owner's live holdings, and "refresh macro
  // read" calls the LLM (2026-09-15 audit).
  "/dashboard/research-journal",
  "/dashboard/calendar",
  // Markets: indices + sectors + treemap visible to viewers. Insider/AI panels
  // are hidden client-side; the routes they call are not listed here.
  "/dashboard/markets",
  // Viewer settings: email digest prefs + broker connection link.
  "/dashboard/user-settings",
  // Per-user watchlist tab.
  "/dashboard/watchlist",
] as const;

/**
 * NO-COST READ routes.
 *
 * Every entry must be read-only over already-persisted tables — no provider
 * call, no LLM call, no write. This is the cost guarantee for shared access:
 * the tenth viewer costs what the first did. A route here that mutates or calls
 * a provider is a defect, not a configuration choice.
 *
 * The axis here is COST, not data ownership. Most entries serve the owner's
 * data, but `/api/user-risk` serves the CALLER's own private risk rows and
 * belongs here all the same: it is GET-only over persisted tables and calls
 * nothing, so it earns the same guarantee and the same sweep. What separates it
 * from the own-data class below is capability — it never writes and never calls
 * a provider — not whose rows it returns.
 *
 * Method matters: `/api/portfolio/performance-series` GET is a read, but its
 * PATCH writes the owner's saved benchmark preference, so only GET is listed.
 */
export type ViewerRoute = {
  prefix: string;
  methods: readonly string[];
  /**
   * Match this path only, not its subpaths. For a route whose CHILDREN are not
   * viewer-safe — `/api/agents/research-journal/context` calls Alpha Vantage and
   * `/evolution` exposes the learning internals — so admitting the prefix would
   * quietly admit them too.
   */
  exact?: boolean;
};

export const VIEWER_API_ROUTES: ReadonlyArray<ViewerRoute> = [
  { prefix: "/api/portfolio/performance-series", methods: ["GET"] },
  { prefix: "/api/research/chart-data", methods: ["GET"] },
  { prefix: "/api/research/universe", methods: ["GET"] },
  { prefix: "/api/auth/role", methods: ["GET"] },
  { prefix: "/api/user-risk", methods: ["GET"] },
  // Research → Daily Funnel. The route strips the owner's live broker snapshot
  // and live fills for a viewer.
  { prefix: "/api/agents/research-journal", methods: ["GET"], exact: true },
  // Score Tracker.
  { prefix: "/api/charts/score-history", methods: ["GET"] },
  { prefix: "/api/scores/point-detail", methods: ["GET"] },
  // Deep Dive (/dashboard/research/[symbol]). Price and trades are role-aware:
  // stored candles only, paper trades only. Fundamentals is the stored-only
  // sibling; the parent `/api/research/fundamentals` calls providers.
  { prefix: "/api/research/price", methods: ["GET"] },
  { prefix: "/api/research/scores", methods: ["GET"] },
  { prefix: "/api/research/trades", methods: ["GET"] },
  { prefix: "/api/research/fundamentals/cached", methods: ["GET"], exact: true },
  // Earnings Calendar (US). The parent route refreshes from Alpha Vantage.
  { prefix: "/api/calendar/earnings/cached", methods: ["GET"], exact: true },
  // Markets page. The parent /api/markets/overview may call Massive for the
  // owner; the stored-only sibling is used for viewers (same pattern as
  // fundamentals/cached and calendar/earnings/cached). The quotes route reads
  // price_cache only (no provider call per its own comment).
  { prefix: "/api/markets/overview/cached", methods: ["GET"], exact: true },
  { prefix: "/api/markets/quotes", methods: ["GET"] },
  // User-watchlist: viewer's own saved symbols + last research metadata.
  { prefix: "/api/user-watchlist", methods: ["GET"] },
];

function matchesRoute(pathname: string, route: ViewerRoute): boolean {
  return route.exact ? pathname === route.prefix : matchesPrefix(pathname, route.prefix);
}

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
  // Turning the daily risk email on or off. A write, but only to the caller's
  // own preference row, and it calls no provider.
  { prefix: "/api/user-risk/prefs", methods: ["GET", "POST"] },
  // Unsubscribe. Reachable with NO session at all (the token is the authority,
  // and an unsubscribe that demands a login is not an unsubscribe) — listed
  // here so that a SIGNED-IN viewer clicking the same link is not 403'd by the
  // viewer API gate.
  { prefix: "/api/user-risk/unsubscribe", methods: ["GET", "POST"] },
  // Per-user watchlist mutations: only touches rows keyed to the caller's uid.
  { prefix: "/api/user-watchlist", methods: ["GET", "POST", "DELETE"] },
  // User notification/newsletter prefs (email digest + newsletter opt-in).
  { prefix: "/api/user-prefs", methods: ["GET", "POST"] },
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
    (route) => matchesRoute(pathname, route) && route.methods.includes(upper),
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
