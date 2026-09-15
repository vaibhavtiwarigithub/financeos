import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ROUTE = code(readFileSync("app/api/admin/access/route.ts", "utf8"));
const HOOK = code(readFileSync("app/api/webhooks/resend/route.ts", "utf8"));
const PAGE = readFileSync("app/dashboard/admin/access/page.tsx", "utf8");
const MIGRATION = readFileSync("supabase/migrations/20260915220000_access_email_notices.sql", "utf8");

// Production 2026-09-15: a deletion notice was accepted by Resend and landed in
// the recipient's spam folder while the page said "the notice email sent". The
// message id was thrown away, so nothing could ever say what happened to it.

describe("every access email keeps its provider message id", () => {
  it("records invitations, sign-in links, revoke and delete notices", () => {
    for (const kind of ["invite", "resend", "revoked", "deleted"]) {
      expect(ROUTE.includes(`"${kind}");`), `${kind} email not recorded`).toBe(true);
    }
    expect(ROUTE.includes("recordNotice(svc, sent.id, email, \"invite\")")).toBe(true);
  });

  it("the lifecycle sender returns the id instead of dropping it", () => {
    expect(ROUTE.includes("Promise<{ ok: boolean; error?: string; id?: string }>")).toBe(true);
  });

  it("records only after a successful send, and never fails the action", () => {
    expect(ROUTE.includes("if (delivery.ok) await recordNotice(")).toBe(true);
    const helper = ROUTE.slice(ROUTE.indexOf("async function recordNotice("), ROUTE.indexOf("async function sendLifecycleNotice("));
    expect(helper.includes("if (!emailId) return;")).toBe(true);
    expect(helper.includes("return NextResponse"), "a logging failure must not fail the access action").toBe(false);
  });
});

describe("the webhook reports delivery for every recorded access email", () => {
  it("updates the notice by message id before looking for a grant (deleted accounts have none)", () => {
    const notice = HOOK.indexOf('from("access_email_notices").update(');
    const grantLookup = HOOK.indexOf('from("app_user_roles").select("user_id").eq("invite_email_id"');
    expect(notice, "webhook does not update access_email_notices").toBeGreaterThan(-1);
    expect(notice).toBeLessThan(grantLookup);
    expect(HOOK.slice(notice, notice + 600).includes('.eq("email_id", emailId)')).toBe(true);
  });

  it("maps complained to its own status rather than calling it a bounce", () => {
    expect(HOOK.includes('type === "email.complained" ? "complained" : "bounced"')).toBe(true);
  });
});

describe("the table is display-only and service-role-only", () => {
  it("enables RLS and creates no client policy", () => {
    expect(MIGRATION.includes("enable row level security")).toBe(true);
    expect(/create\s+policy/i.test(MIGRATION)).toBe(false);
  });

  it("constrains kind and status to known values", () => {
    expect(MIGRATION.includes("check (kind in ('invite', 'resend', 'revoked', 'deleted'))")).toBe(true);
    expect(MIGRATION.includes("check (status in ('accepted', 'delivered', 'bounced', 'complained'))")).toBe(true);
  });
});

describe("the page never overclaims delivery", () => {
  it("no longer says the notice was sent when it was only accepted", () => {
    expect(PAGE.includes("and the notice email sent."), "page claims delivery").toBe(false);
    expect(PAGE.includes("the notice email was sent."), "page claims delivery").toBe(false);
    expect(PAGE.includes("accepted for delivery")).toBe(true);
  });

  it("explains that a spam folder is invisible and names a spam report separately", () => {
    expect(PAGE.includes("Reported as spam by recipient")).toBe(true);
    expect(PAGE.includes("can still land in a spam folder")).toBe(true);
  });
});
