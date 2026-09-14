import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ACCESS = code(read("app/api/admin/access/route.ts"));
const LOGIN = code(read("app/login/page.tsx"));
const RESET = code(read("app/reset-password/page.tsx"));
const TEMPLATE = read("lib/email/invite-email.ts");

// Observed 2026-09-14 on a real test invitation: the "Accept invitation" link
// opened http://localhost:3000 and died with ERR_CONNECTION_FAILED. The cause
// was `inviteUserByEmail(email)` with no options, so Supabase fell back to the
// project's Site URL. Every invitation ever sent pointed at the recipient's own
// machine.

describe("an invitation points at the deployed app, not localhost", () => {
  it("passes an explicit redirectTo when minting the link", () => {
    expect(ACCESS.includes("generateLink(")).toBe(true);
    expect(ACCESS.includes("options: { redirectTo }")).toBe(true);
  });

  it("derives the base from configuration or the live request, never a literal", () => {
    expect(ACCESS.includes("process.env.APP_BASE_URL || req.nextUrl.origin")).toBe(true);
    expect(/redirectTo\s*=\s*[`'"]https?:\/\/localhost/.test(ACCESS), "hardcoded localhost").toBe(false);
  });

  it("lands on the page that can actually set a password", () => {
    expect(ACCESS.includes("/reset-password`")).toBe(true);
    // That page gates on a session rather than on a specific event type, which
    // is why an invite link works there without a change.
    expect(RESET.includes("if (data.session) setReady(true)")).toBe(true);
  });

  it("does not double-slash when APP_BASE_URL has a trailing slash", () => {
    expect(ACCESS.includes('base.replace(/\\/+$/, "")')).toBe(true);
  });
});

describe("password reset was never affected, and stays that way", () => {
  it("sends the caller's real origin", () => {
    expect(LOGIN.includes("redirect_to: `${window.location.origin}/reset-password`")).toBe(true);
  });
});

describe("the invitation is from Kairos, not from Supabase", () => {
  it("mints the link instead of letting Supabase send its stock template", () => {
    expect(ACCESS.includes("generateLink("), "still using Supabase's own mailer").toBe(true);
    expect(ACCESS.includes("inviteUserByEmail"), "inviteUserByEmail sends the unbranded email").toBe(false);
  });

  it("sends through the app's own provider, with the app's own from-address", () => {
    expect(ACCESS.includes("getEmailProvider()")).toBe(true);
    expect(ACCESS.includes("process.env.EMAIL_FROM")).toBe(true);
  });

  it("re-invites an existing account with a recovery link, which Supabase will accept", () => {
    // `type: "invite"` is rejected for an address that already has an account,
    // which is exactly the revoked-then-restored case.
    expect(ACCESS.includes('type: returning ? "recovery" : "invite"')).toBe(true);
  });

  it("says who invited them and what the tool is", () => {
    expect(TEMPLATE.includes("KAIROS")).toBe(true);
    expect(TEMPLATE.includes("has given you read-only access")).toBe(true);
    expect(TEMPLATE.includes("Personal investing research")).toBe(true);
  });

  it("states the limits plainly, including that they cannot trade", () => {
    expect(TEMPLATE.includes("cannot</strong> trade")).toBe(true);
    expect(TEMPLATE.includes("Nothing in it is investment advice")).toBe(true);
  });

  it("renders in mail clients — tables, no inline SVG", () => {
    expect(TEMPLATE.includes("<svg"), "Gmail strips inline SVG").toBe(false);
    expect(TEMPLATE.includes("role=\"presentation\"")).toBe(true);
    expect(/display:\s*(flex|grid)/.test(TEMPLATE)).toBe(false);
  });

  it("escapes the note, which is free text the owner typed", () => {
    expect(TEMPLATE.includes("esc(note)")).toBe(true);
  });
});

describe("a failed send never grants silent access", () => {
  it("refuses before writing the grant when email is unavailable", () => {
    // Granting access to someone who was never told they have it is worse than
    // failing the request: they would never know to use it, and the owner would
    // believe the invitation went out.
    const inviteFn = ACCESS.slice(ACCESS.indexOf("async function invite("));
    const beforeGrant = inviteFn.slice(0, inviteFn.indexOf('.from("app_user_roles")'));
    expect(beforeGrant.length, "slice found nothing — the assertion would be vacuous").toBeGreaterThan(200);
    expect(beforeGrant.includes("provider.isAvailable()")).toBe(true);
    expect(beforeGrant.includes("No access was granted.")).toBe(true);
  });

  it("also refuses when the send itself throws", () => {
    const inviteFn = ACCESS.slice(ACCESS.indexOf("async function invite("));
    const beforeGrant = inviteFn.slice(0, inviteFn.indexOf('.from("app_user_roles")'));
    expect(beforeGrant.includes("invitation email could not be sent")).toBe(true);
  });

  it("never returns the action link to the browser — it sets a password", () => {
    const response = ACCESS.slice(ACCESS.indexOf('return NextResponse.json({\n    ok: true,'));
    expect(response.includes("actionLink")).toBe(false);
    expect(response.includes("action_link")).toBe(false);
  });
});
