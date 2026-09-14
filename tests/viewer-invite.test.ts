import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isViewerApiRoute, isViewerPage } from "@/lib/auth/roles";

const ROOT = resolve(__dirname, "..");
const ROUTE = readFileSync(resolve(ROOT, "app/api/admin/access/route.ts"), "utf8");
const PAGE = readFileSync(resolve(ROOT, "app/dashboard/admin/access/page.tsx"), "utf8");

// Inviting someone is the one action here that reaches OUTSIDE the system — it
// emails a real person and creates a real account. These are the two ways it
// could go wrong that would actually matter.

describe("viewer invitation — access control", () => {
  it("the access API is not reachable by a viewer, on any method", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect(isViewerApiRoute("/api/admin/access", method), method).toBe(false);
    }
  });

  it("the access page is not reachable by a viewer", () => {
    expect(isViewerPage("/dashboard/admin/access")).toBe(false);
  });

  it("every handler in the access route is owner-gated", () => {
    const handlers = ROUTE.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    // requireOwner must appear at least once per exported handler.
    const gates = ROUTE.match(/requireOwner\(\)/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(handlers.length);
  });
});

describe("viewer invitation — never handles a password", () => {
  it("the route neither accepts nor returns a password", () => {
    // The recipient sets their own. Anything that looks like password handling
    // here is a defect, not a convenience.
    //
    // The route legitimately names the PATH `/reset-password` — that is where an
    // invited person lands to choose their first password, and passing it as
    // redirectTo is what stopped invitations pointing at localhost. A route name
    // is not password handling, so it is excluded by exact literal before the
    // check; every other mention of "password" still fails this test.
    const body = ROUTE
      .replace(/^\s*(\/\/|\*).*$/gm, "")
      .split("/reset-password").join("/<landing-route>");
    expect(/password/i.test(body), "route mentions a password outside comments").toBe(false);
  });

  it("mints the invitation link rather than letting Supabase mail it", () => {
    // Was `inviteUserByEmail`, which sends Supabase's unbranded stock template
    // from "Supabase Auth". generateLink returns the same one-time link without
    // sending, so the app delivers its own branded mail.
    const body = ROUTE.replace(/^\s*(\/\/|\*).*$/gm, "");
    expect(body.includes("generateLink("), "route no longer mints an invite link").toBe(true);
    // Comments explain why it was replaced; the CODE must not call it.
    expect(body.includes("inviteUserByEmail"), "back to Supabase's own mailer").toBe(false);
  });

  it("the invite form collects only an email", () => {
    expect(/type="password"/.test(PAGE), "access page renders a password field").toBe(false);
    expect(PAGE.includes('type="email"')).toBe(true);
  });

  it("refuses to invite the owner's own address", () => {
    expect(ROUTE.includes("OWNER_EMAIL.toLowerCase()"), "owner self-invite guard missing").toBe(true);
  });

  it("grants only the viewer role — the role is not caller-supplied", () => {
    expect(/role:\s*"viewer"/.test(ROUTE)).toBe(true);
    expect(/role:\s*(String\(|body)/.test(ROUTE), "role is taken from the request body").toBe(false);
  });
});
