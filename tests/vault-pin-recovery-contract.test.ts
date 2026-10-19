import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("forgotten Vault PIN recovery contract", () => {
  const route = read("app/api/admin/vault/change-pin/route.ts");
  const page = read("app/dashboard/admin/vault/page.tsx");

  it("sends recovery only to the canonical owner and only after owner-session verification", () => {
    expect(route).toContain('import { OWNER_EMAIL } from "@/lib/auth/owner"');
    expect(route).toContain("user.email !== ADMIN_EMAIL || !user.email_confirmed_at");
    expect(route).toContain('if (action === "send_recovery_otp")');
    expect(route).toContain("email: OWNER_EMAIL");
    expect(route).toContain("shouldCreateUser: false");
    const recoveryStart = route.indexOf('if (action === "send_recovery_otp")');
    const recoveryEnd = route.indexOf('if (action === "verify_and_set")', recoveryStart);
    expect(recoveryStart).toBeGreaterThan(route.indexOf("if (!user"));
    expect(route.slice(recoveryStart, recoveryEnd)).not.toContain("checkCurrentPin");
  });

  it("changes the stored PIN only after verifying the emailed OTP and hashes it", () => {
    const verifyAt = route.indexOf("await sb.auth.verifyOtp");
    const writeAt = route.indexOf(".upsert({", verifyAt);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(verifyAt);
    expect(route.slice(verifyAt, writeAt)).toContain("if (otpErr)");
    expect(route.slice(writeAt)).toContain("value: hashPin(new_pin.trim())");
    expect(route).toContain("/^\\d{6,8}$/");
  });

  it("exposes recovery from the locked Vault screen and verifies the new PIN through the Vault API", () => {
    expect(page).toContain("Forgot PIN? Email me a reset code");
    expect(page).toContain('action: "send_recovery_otp"');
    expect(page).toContain('action: "verify_and_set"');
    expect(page).toContain('fetch("/api/admin/vault", { headers: { "x-vault-pin": recoveryNewPIN.trim() } })');
    expect(page).toContain("This does not change any API keys.");
  });

  it("uses the shared confirmed-owner gate for both Vault read and write endpoints", () => {
    const vaultApi = read("app/api/admin/vault/route.ts");
    expect(vaultApi.match(/await requireOwner\(\)/g)).toHaveLength(2);
  });
});
