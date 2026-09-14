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
const RESEND = code(read("lib/providers/email/resend.ts"));
const EMAIL_INDEX = code(read("lib/providers/email/index.ts"));

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
    expect(beforeGrant.includes("emailDeliveryAvailable()")).toBe(true);
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

describe("availability is asked the way the send resolves it", () => {
  // Production 2026-09-14: the route reported "email is not configured, so the
  // invitation could not be sent" while RESEND_API_KEY had been sitting in
  // api_key_vault since 2026-07-02. isAvailable() reads only process.env; the
  // provider's own resolveKey() prefers the vault. A guard that asks the wrong
  // question fails closed on a healthy system.
  it("the invite route does not gate on the env-only check", () => {
    const inviteFn = ACCESS.slice(ACCESS.indexOf("async function invite("));
    expect(inviteFn.includes("emailDeliveryAvailable()")).toBe(true);
    expect(/provider\.isAvailable\(\)/.test(inviteFn), "still gating on the env-only check").toBe(false);
  });

  it("the async check resolves the key the same way the send does", () => {
    expect(RESEND.includes("async isDeliverable()")).toBe(true);
    expect(RESEND.includes("return Boolean(await this.resolveKey())")).toBe(true);
    expect(EMAIL_INDEX.includes("export async function emailDeliveryAvailable")).toBe(true);
  });

  it("falls back to the sync check for a provider without the async one", () => {
    expect(EMAIL_INDEX.includes("return provider.isAvailable()")).toBe(true);
  });
});

describe("a silent send failure cannot grant access", () => {
  it("uses the checked send, because send() swallows everything", () => {
    // `send` returns void and catches its own errors, so the previous
    // try/catch around it could never have fired.
    const inviteFn = ACCESS.slice(ACCESS.indexOf("async function invite("));
    expect(inviteFn.includes("provider.sendChecked")).toBe(true);
    expect(inviteFn.includes("if (!sent.ok)")).toBe(true);
  });

  it("sendChecked reports a missing key rather than returning quietly", () => {
    expect(RESEND.includes("async sendChecked(")).toBe(true);
    expect(RESEND.includes('return { ok: false, error: "no Resend API key in env or api_key_vault" }')).toBe(true);
  });

  it("does not echo the provider's response body, which can carry request detail", () => {
    expect(RESEND.includes("Resend returned HTTP ${res.status}")).toBe(true);
  });

  it("still refuses before writing the grant", () => {
    const inviteFn = ACCESS.slice(ACCESS.indexOf("async function invite("));
    const beforeGrant = inviteFn.slice(0, inviteFn.indexOf('.from("app_user_roles")'));
    expect(beforeGrant.includes("No access was granted.")).toBe(true);
  });
});
