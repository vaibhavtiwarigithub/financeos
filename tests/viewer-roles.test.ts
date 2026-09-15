import { describe, expect, it } from "vitest";
import {
  resolveRole,
  isViewerPage,
  isViewerApiRoute,
  describeRoleAccess,
  VIEWER_PAGES,
  VIEWER_API_ROUTES,
} from "@/lib/auth/roles";

const OWNER = "vterminater@gmail.com";
const CONFIRMED = "2026-01-01T00:00:00Z";

describe("role resolution", () => {
  it("owner needs the right email AND a confirmed address", () => {
    expect(resolveRole(OWNER, CONFIRMED, null)).toBe("owner");
    expect(resolveRole(OWNER, null, null)).toBeNull();
  });

  it("a guest is a viewer only with a live grant", () => {
    expect(resolveRole("friend@example.com", CONFIRMED, { revoked_at: null })).toBe("viewer");
    expect(resolveRole("friend@example.com", CONFIRMED, null)).toBeNull();
  });

  it("revocation removes access — the grant row is kept, not deleted", () => {
    expect(resolveRole("friend@example.com", CONFIRMED, { revoked_at: "2026-09-14T00:00:00Z" })).toBeNull();
  });

  it("never falls back to a default role for an unknown account", () => {
    expect(resolveRole("stranger@example.com", CONFIRMED, undefined)).toBeNull();
    expect(resolveRole(null, null, null)).toBeNull();
  });

  it("owner outranks a revoked grant rather than being locked out by it", () => {
    expect(resolveRole(OWNER, CONFIRMED, { revoked_at: "2026-09-14T00:00:00Z" })).toBe("owner");
  });
});

describe("viewer page boundary", () => {
  it("admits the permitted pages and their subpaths", () => {
    expect(isViewerPage("/dashboard/portfolio")).toBe(true);
    expect(isViewerPage("/dashboard/research")).toBe(true);
    expect(isViewerPage("/dashboard/symbol/AAPL")).toBe(true);
  });

  it("does not let a prefix match leak a different page", () => {
    // The bug this guards: "/dashboard/research" must NOT admit a separate page
    // that merely starts with the same letters. "/dashboard/research-journal" is
    // now allowlisted in its own right (2026-09-15), so lookalikes that are NOT
    // allowlisted carry the check.
    expect(isViewerPage("/dashboard/research-evil")).toBe(false);
    expect(isViewerPage("/dashboard/researcher")).toBe(false);
    expect(isViewerPage("/dashboard/portfolio-admin")).toBe(false);
    expect(isViewerPage("/dashboard/calendar-admin")).toBe(false);
  });

  it("keeps owner-private pages out", () => {
    for (const page of [
      "/dashboard", "/dashboard/live-portfolio", "/dashboard/risk", "/dashboard/settings",
      "/dashboard/agents", "/dashboard/admin/access", "/admin", "/property",
    ]) {
      expect(isViewerPage(page), page).toBe(false);
    }
  });
});

describe("viewer API boundary", () => {
  it("allows the reads that back the viewer pages", () => {
    expect(isViewerApiRoute("/api/portfolio/performance-series", "GET")).toBe(true);
    expect(isViewerApiRoute("/api/research/universe", "GET")).toBe(true);
  });

  it("blocks the write method on an otherwise-allowed route", () => {
    // PATCH writes the owner's saved benchmark preference.
    expect(isViewerApiRoute("/api/portfolio/performance-series", "PATCH")).toBe(false);
    expect(isViewerApiRoute("/api/portfolio/performance-series", "POST")).toBe(false);
  });

  it("blocks money-path and agent routes outright", () => {
    for (const route of [
      "/api/paper-positions/close", "/api/agents/trader", "/api/agents/paper-trade",
      "/api/admin/access", "/api/admin/vault", "/api/markets/quotes", "/api/calendar/earnings",
    ]) {
      expect(isViewerApiRoute(route, "GET"), route).toBe(false);
      expect(isViewerApiRoute(route, "POST"), route).toBe(false);
    }
  });

  it("every declared viewer API route is read-only by method", () => {
    for (const route of VIEWER_API_ROUTES) {
      expect(route.methods, route.prefix).toEqual(["GET"]);
    }
  });
});

describe("access description shown to the owner", () => {
  it("reports viewers as read-only and lists exactly the permitted pages", () => {
    const viewer = describeRoleAccess("viewer");
    expect(viewer.canEdit).toBe(false);
    expect(viewer.pages).toEqual([...VIEWER_PAGES]);
    expect(describeRoleAccess("owner").canEdit).toBe(true);
  });
});
