import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("forgotten Vault PIN recovery contract", () => {
  const route = read("app/api/admin/vault/change-pin/route.ts");
  const page = read("app/dashboard/admin/vault/page.tsx");

  it("generates and sends a recovery OTP only to the canonical owner", () => {
    expect(route).toContain('import { OWNER_EMAIL } from "@/lib/auth/owner"');
    expect(route).toContain("user.email !== ADMIN_EMAIL || !user.email_confirmed_at");
    expect(route).toContain('if (action === "send_recovery_code")');
    expect(route).toContain('generateLink({ type: "recovery", email: OWNER_EMAIL })');
    expect(route).toContain('typeof code !== "string" || !/^\\d{6}$/.test(code)');
    expect(route).toContain("emailDeliveryAvailable()");
    expect(route).toContain("provider.sendChecked");
    expect(route).toContain("to: OWNER_EMAIL");
    const recoveryStart = route.indexOf('if (action === "send_recovery_code")');
    const recoveryEnd = route.indexOf('if (action === "verify_code_and_set")', recoveryStart);
    expect(recoveryStart).toBeGreaterThan(route.indexOf("if (!user"));
    expect(route.slice(recoveryStart, recoveryEnd)).not.toContain("checkCurrentPin");
    expect(route).not.toContain("emailRedirectTo");
  });

  it("changes the PIN only after a one-time recovery OTP verifies the confirmed owner", () => {
    const verifyAt = route.indexOf('if (action === "verify_code_and_set")');
    const writeAt = route.indexOf(".upsert({", verifyAt);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(route.slice(verifyAt, writeAt)).toContain('type: "recovery"');
    expect(route.slice(verifyAt, writeAt)).toContain("verified.user?.email !== OWNER_EMAIL");
    expect(route.slice(verifyAt, writeAt)).toContain("verified.user.email_confirmed_at");
    expect(route.slice(verifyAt, writeAt)).toContain("return NextResponse.json({ error:");
    expect(route.slice(writeAt)).toContain("value: hashPin(new_pin.trim())");
    expect(route).toContain("verifyOtp");
    expect(route).not.toContain("last_sign_in_at");
  });

  it("exposes code recovery, confirms the new PIN, then unlocks through the Vault API", () => {
    expect(page).toContain("Forgot PIN? Email me a reset code");
    expect(page).toContain('action: "send_recovery_code"');
    expect(page).toContain('action: "verify_code_and_set"');
    expect(page).toContain('autoComplete="one-time-code"');
    expect(page).toContain("recoveryNewPIN.trim() !== recoveryConfirmPIN.trim()");
    expect(page).toContain('fetch("/api/admin/vault", { headers: { "x-vault-pin": recoveryNewPIN.trim() } })');
    expect(page).toContain("This changes only your Vault PIN");
  });

  it("sends a branded code-only email without a clickable auth URL", () => {
    const email = read("lib/email/vault-pin-recovery-email.ts");
    expect(email).toContain("Your Kairos Vault PIN reset code");
    expect(email).toContain("${escapeHtml(input.code)}");
    expect(email).toContain("can be used once");
    expect(email).not.toContain("ConfirmationURL");
    expect(email).not.toContain("action_link");
  });

  it("uses the shared confirmed-owner gate for both Vault read and write endpoints", () => {
    const vaultApi = read("app/api/admin/vault/route.ts");
    expect(vaultApi.match(/await requireOwner\(\)/g)).toHaveLength(2);
  });
});
