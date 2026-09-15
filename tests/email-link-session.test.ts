import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildEmailLink,
  establishEmailLinkSession,
  parseEmailLink,
  safeNextPath,
  SET_PASSWORD_LINK_TYPES,
  SIGN_IN_LINK_TYPES,
} from "@/lib/auth/email-link";

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function fakeSupabase(user: { id: string; email: string } | null, error: any = null) {
  const res = async () => ({ data: { user, session: user ? { user } : null }, error });
  return {
    auth: {
      verifyOtp: vi.fn(res),
      exchangeCodeForSession: vi.fn(res),
      setSession: vi.fn(res),
      getSession: vi.fn(async () => ({ data: { session: { user: { id: "owner", email: "owner@x.com" } } }, error: null })),
    },
  };
}

describe("parseEmailLink reads every link format", () => {
  it("our token link", () => {
    expect(parseEmailLink("?token_hash=abc&type=invite", "")).toEqual({ kind: "otp", tokenHash: "abc", type: "invite" });
  });
  it("a PKCE code", () => {
    expect(parseEmailLink("?code=xyz", "")).toEqual({ kind: "code", code: "xyz" });
  });
  it("Supabase's own hash tokens (Forgot password emails)", () => {
    expect(parseEmailLink("", "#access_token=a&refresh_token=r&type=recovery"))
      .toEqual({ kind: "implicit", accessToken: "a", refreshToken: "r", type: "recovery" });
  });
  it("an expired link reported in the hash", () => {
    expect(parseEmailLink("", "#error=access_denied&error_description=Email+link+is+invalid+or+has+expired"))
      .toEqual({ kind: "error", message: "Email link is invalid or has expired" });
  });
  it("nothing at all", () => {
    expect(parseEmailLink("", "")).toEqual({ kind: "none" });
  });
});

describe("establishEmailLinkSession acts only on the account the link proves", () => {
  it("THE REGRESSION: a leftover session with no link is never accepted", async () => {
    const sb = fakeSupabase({ id: "viewer", email: "v@x.com" });
    const r = await establishEmailLinkSession(sb as any, { kind: "none" }, SET_PASSWORD_LINK_TYPES);
    expect(r.ok).toBe(false);
    expect(sb.auth.getSession).not.toHaveBeenCalled();
    expect(sb.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("verifies an invite token and returns that account", async () => {
    const sb = fakeSupabase({ id: "viewer", email: "v@x.com" });
    const r = await establishEmailLinkSession(sb as any, { kind: "otp", tokenHash: "t", type: "invite" }, SET_PASSWORD_LINK_TYPES);
    expect(sb.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "t", type: "invite" });
    expect(r).toEqual({ ok: true, userId: "viewer", email: "v@x.com" });
  });

  it("a sign-in link cannot be used to set a password", async () => {
    const sb = fakeSupabase({ id: "viewer", email: "v@x.com" });
    const r = await establishEmailLinkSession(sb as any, { kind: "otp", tokenHash: "t", type: "magiclink" }, SET_PASSWORD_LINK_TYPES);
    expect(r.ok).toBe(false);
    expect(sb.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("a recovery link cannot be used as a plain sign-in link", async () => {
    const sb = fakeSupabase({ id: "viewer", email: "v@x.com" });
    const r = await establishEmailLinkSession(sb as any, { kind: "otp", tokenHash: "t", type: "recovery" }, SIGN_IN_LINK_TYPES);
    expect(r.ok).toBe(false);
  });

  it("an already-used token is reported, not silently treated as signed in", async () => {
    const sb = fakeSupabase(null, { message: "Token has expired or is invalid" });
    const r = await establishEmailLinkSession(sb as any, { kind: "otp", tokenHash: "t", type: "recovery" }, SET_PASSWORD_LINK_TYPES);
    expect(r.ok).toBe(false);
  });

  it("Supabase hash tokens replace the session via setSession", async () => {
    const sb = fakeSupabase({ id: "viewer", email: "v@x.com" });
    const r = await establishEmailLinkSession(sb as any, { kind: "implicit", accessToken: "a", refreshToken: "r", type: "recovery" }, SET_PASSWORD_LINK_TYPES);
    expect(sb.auth.setSession).toHaveBeenCalledWith({ access_token: "a", refresh_token: "r" });
    expect(r.ok).toBe(true);
  });
});

describe("links are built from the one-time token", () => {
  it("encodes token and type, handles a trailing slash, adds next", () => {
    expect(buildEmailLink("https://app.example/", "/auth/confirm", { hashed_token: "a b", verification_type: "magiclink" }, "/dashboard/portfolio"))
      .toBe("https://app.example/auth/confirm?token_hash=a+b&type=magiclink&next=%2Fdashboard%2Fportfolio");
  });
  it("fails closed when Supabase returned no token", () => {
    expect(buildEmailLink("https://app.example", "/reset-password", { verification_type: "invite" })).toBeNull();
    expect(buildEmailLink("https://app.example", "/reset-password", null)).toBeNull();
  });
  it("next is same-origin only", () => {
    expect(safeNextPath("/dashboard/portfolio", "/dashboard")).toBe("/dashboard/portfolio");
    expect(safeNextPath("//evil.com", "/dashboard")).toBe("/dashboard");
    expect(safeNextPath("https://evil.com", "/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/@evil.com", "/dashboard")).toBe("/dashboard");
  });
});

describe("the pages and the route keep this contract", () => {
  const RESET = code(readFileSync("app/reset-password/page.tsx", "utf8"));
  const CONFIRM = code(readFileSync("app/auth/confirm/page.tsx", "utf8"));
  const ROUTE = code(readFileSync("app/api/admin/access/route.ts", "utf8"));

  it("the set-password page never uses an existing session to decide", () => {
    expect(RESET.includes("getSession("), "reset page reads a leftover session").toBe(false);
    expect(RESET.includes("establishEmailLinkSession(")).toBe(true);
    expect(RESET.includes("SET_PASSWORD_LINK_TYPES")).toBe(true);
  });

  it("the set-password page re-checks the account right before changing the password", () => {
    const submit = RESET.slice(RESET.indexOf("async function handleSubmit"));
    const check = submit.indexOf("user.id !== target.userId");
    const update = submit.indexOf("updateUser(");
    expect(check, "no account re-check before updateUser").toBeGreaterThan(-1);
    expect(check).toBeLessThan(update);
  });

  it("the set-password page shows which account is being changed", () => {
    expect(RESET.includes("target.email")).toBe(true);
  });

  it("the sign-in page only accepts sign-in links and guards next", () => {
    expect(CONFIRM.includes("SIGN_IN_LINK_TYPES")).toBe(true);
    expect(CONFIRM.includes("safeNextPath(")).toBe(true);
  });

  it("the access route mails token links, never Supabase's hash-token action_link", () => {
    expect(ROUTE.includes("properties?.action_link"), "still mailing action_link").toBe(false);
    expect((ROUTE.match(/buildEmailLink\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(ROUTE.includes('"/reset-password"')).toBe(true);
    expect(ROUTE.includes('"/auth/confirm"')).toBe(true);
  });
});
