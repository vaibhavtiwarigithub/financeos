import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const ROUTE = readFileSync(resolve(ROOT, "app/api/auth/password-reset/route.ts"), "utf8");
const LOGIN = readFileSync(resolve(ROOT, "app/login/page.tsx"), "utf8");

// The reset endpoint SENDS EMAIL, so it must not mail strangers or reveal which
// addresses have accounts. The original client-side guard achieved both by
// refusing anything but the owner's address — which also locked invited viewers
// out of their own password reset. These assert the replacement keeps both
// protections while closing that gap.

describe("password reset — eligibility", () => {
  it("allows the owner and any account with a LIVE grant", () => {
    expect(ROUTE.includes("OWNER_EMAIL.toLowerCase()")).toBe(true);
    expect(ROUTE.includes("app_user_roles")).toBe(true);
  });

  it("treats a revoked grant as ineligible — revocation leaves no way back in", () => {
    expect(/!data\.revoked_at/.test(ROUTE), "revoked_at is not checked").toBe(true);
  });

  it("no longer refuses every non-owner address on the client", () => {
    // The old guard: `if (email !== OWNER_EMAIL) { setError("Access restricted."); return; }`
    // inside handleForgotPassword. Its return meant a viewer got nothing.
    const forgot = LOGIN.slice(
      LOGIN.indexOf("async function handleForgotPassword"),
      LOGIN.indexOf("async function handleEmail"),
    );
    expect(forgot.includes("Access restricted."), "client still refuses non-owner addresses").toBe(false);
    expect(forgot.includes("/api/auth/password-reset"), "client no longer uses the server route").toBe(true);
  });
});

describe("password reset — cannot be used to discover who has access", () => {
  it("every response path returns the same payload", () => {
    const returns = ROUTE.match(/return NextResponse\.json\(([^)]*)\)/g) ?? [];
    expect(returns.length).toBeGreaterThan(1);
    for (const r of returns) {
      expect(r, `a response differs from the constant: ${r}`).toContain("SAME_ANSWER");
    }
  });

  it("the provider's own failure is never surfaced", () => {
    // "user not found" leaking back would turn this into an account probe.
    expect(/resetPasswordForEmail[\s\S]{0,200}catch\(\(\) => \{\}\)/.test(ROUTE)).toBe(true);
  });

  it("the message does not confirm the address exists", () => {
    expect(ROUTE.includes("If that address has access")).toBe(true);
  });
});

describe("self-signup is gone", () => {
  it("the login page can no longer create an account", () => {
    expect(/\bsignUp\s*\(/.test(LOGIN), "login page still calls signUp()").toBe(false);
    expect(LOGIN.includes('"signup"'), "login page still has a signup mode").toBe(false);
  });

  it("sign-in and password reset both still exist", () => {
    expect(LOGIN.includes("signInWithPassword")).toBe(true);
    expect(LOGIN.includes("handleForgotPassword")).toBe(true);
  });
});
