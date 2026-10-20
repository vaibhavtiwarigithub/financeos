import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("owner-session-only API Vault", () => {
  const vaultRoute = read("app/api/admin/vault/route.ts");
  const vaultPage = read("app/dashboard/admin/vault/page.tsx");
  const ownerGate = read("lib/auth/require-owner.ts");
  const webullRoute = read("app/api/data-providers/webull-openapi-auth/route.ts");
  const settingsPage = read("app/dashboard/settings/page.tsx");

  it("checks the confirmed owner session before every privileged Vault read or write", () => {
    const getStart = vaultRoute.indexOf("export async function GET");
    const postStart = vaultRoute.indexOf("export async function POST");
    expect(getStart).toBeGreaterThan(-1);
    expect(postStart).toBeGreaterThan(getStart);
    expect(vaultRoute.slice(getStart, postStart)).toContain("await requireOwner()");
    expect(vaultRoute.slice(postStart)).toContain("await requireOwner()");
    expect(ownerGate).toContain("user.email !== OWNER_EMAIL");
    expect(ownerGate).toContain("!user.email_confirmed_at");
    expect(vaultRoute).toContain("key_value: maskKey(r.key_value)");
  });

  it("does not implement a second PIN/password gate or return raw stored keys", () => {
    expect(vaultRoute).not.toMatch(/x-vault-pin|VAULT_PIN|vault_pin|verifyPin/i);
    expect(vaultPage).not.toMatch(/x-vault-pin|VAULT_PIN|vault_pin|Forgot PIN|Unlock Vault|Vault PIN/i);
    expect(vaultPage).toContain('fetch("/api/admin/vault", { cache: "no-store" })');
    expect(vaultPage).toContain('fetch("/api/admin/vault"');
  });

  it("keeps Webull token creation and checks owner-only without another PIN prompt", () => {
    const postStart = webullRoute.indexOf("export async function POST");
    const providerCall = webullRoute.indexOf("callWebullTokenApi(", postStart);
    expect(webullRoute.slice(postStart, providerCall)).toContain("await requireOwner()");
    expect(webullRoute).not.toMatch(/x-vault-pin|VAULT_PIN|vault_pin|verifyPin/i);
    expect(settingsPage).not.toMatch(/webullVaultPin|x-vault-pin|vault_pin_required/i);
    expect(settingsPage).toContain('body: JSON.stringify({ action: "create" })');
    expect(settingsPage).toContain('body: JSON.stringify({ action: "check" })');
    expect(settingsPage).toContain("webullAuthResult.httpStatus === 401");
  });

  it("removes obsolete PIN creation and email-reset endpoints", () => {
    expect(existsSync("app/api/admin/vault/change-pin/route.ts")).toBe(false);
    expect(existsSync("lib/vault-pin.ts")).toBe(false);
    expect(existsSync("lib/vault-pin-recovery.ts")).toBe(false);
  });
});
