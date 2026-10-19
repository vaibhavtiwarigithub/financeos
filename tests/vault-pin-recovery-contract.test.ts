import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("forgotten Vault PIN recovery contract", () => {
  const route = read("app/api/admin/vault/change-pin/route.ts");
  const page = read("app/dashboard/admin/vault/page.tsx");

  it("sends a magic link only to the canonical owner and returns to the locked Vault", () => {
    expect(route).toContain('import { OWNER_EMAIL } from "@/lib/auth/owner"');
    expect(route).toContain("user.email !== ADMIN_EMAIL || !user.email_confirmed_at");
    expect(route).toContain('if (action === "send_recovery_link")');
    expect(route).toContain("email: OWNER_EMAIL");
    expect(route).toContain("shouldCreateUser: false");
    expect(route).toContain("process.env.NEXT_PUBLIC_SITE_URL");
    expect(route).toContain("process.env.NEXT_PUBLIC_APP_URL");
    expect(route).toContain('emailRedirectTo: redirectTo.toString()');
    expect(route).toContain('redirectTo.searchParams.set("next", "/dashboard/admin/vault?pin_recovery=1")');
    const recoveryStart = route.indexOf('if (action === "send_recovery_link")');
    const recoveryEnd = route.indexOf('if (action === "verify_link_and_set")', recoveryStart);
    expect(recoveryStart).toBeGreaterThan(route.indexOf("if (!user"));
    expect(route.slice(recoveryStart, recoveryEnd)).not.toContain("checkCurrentPin");
  });

  it("changes the PIN only after a fresh confirmed-owner sign-in and stores a salted hash", () => {
    const verifyAt = route.indexOf('if (action === "verify_link_and_set")');
    const writeAt = route.indexOf(".upsert({", verifyAt);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(route.slice(verifyAt, writeAt)).toContain("user.last_sign_in_at");
    expect(route.slice(verifyAt, writeAt)).toContain("ageMs > 15 * 60_000");
    expect(route.slice(verifyAt, writeAt)).toContain("return NextResponse.json({ error:");
    expect(route.slice(writeAt)).toContain("value: hashPin(new_pin.trim())");
    expect(route).not.toContain("verifyOtp");
  });

  it("exposes link recovery and only unlocks after verifying the new PIN through the Vault API", () => {
    expect(page).toContain("Forgot PIN? Email me a reset link");
    expect(page).toContain('action: "send_recovery_link"');
    expect(page).toContain('action: "verify_link_and_set"');
    expect(page).toContain('get("pin_recovery") === "1"');
    expect(page).toContain('fetch("/api/admin/vault", { headers: { "x-vault-pin": recoveryNewPIN.trim() } })');
    expect(page).toContain("This does not change any API keys.");
    expect(page).not.toContain("Email code");
  });

  it("uses the shared confirmed-owner gate for both Vault read and write endpoints", () => {
    const vaultApi = read("app/api/admin/vault/route.ts");
    expect(vaultApi.match(/await requireOwner\(\)/g)).toHaveLength(2);
  });
});
