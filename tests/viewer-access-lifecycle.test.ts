import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/admin/access/route.ts", "utf8");
const page = readFileSync("app/dashboard/admin/access/page.tsx", "utf8");
const middleware = readFileSync("middleware.ts", "utf8");

describe("viewer access lifecycle", () => {
  it("offers a deliberate resend route with a one-time sign-in link", () => {
    expect(route).toContain('if (action === "resend") return resendAccess(body, req)');
    expect(route).toContain('type: "magiclink"');
    expect(route).toContain("buildAccessResendEmailHtml");
  });

  it("revokes before deletion and requires an exact typed confirmation", () => {
    expect(route).toContain('String(body?.confirmation ?? "") !== `DELETE ${email}`');
    expect(route).toContain('await svc.from("app_user_roles").update({ revoked_at: new Date().toISOString(), revoked_by: OWNER_EMAIL })');
    expect(route).toContain("await svc.auth.admin.deleteUser(userId)");
    expect(route).toContain('sendLifecycleNotice({ kind: "deleted"');
  });

  it("makes the owner explicitly choose destructive deletion in the UI", () => {
    expect(page).toContain("Resend email");
    expect(page).toContain("Delete account");
    expect(page).toContain("Type exactly: DELETE ${g.email}");
  });

  it("requires a confirmed owner identity at the edge", () => {
    expect(middleware).toContain("isOwnerIdentity(user?.email, user?.email_confirmed_at)");
  });
});
