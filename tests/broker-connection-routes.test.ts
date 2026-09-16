import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isViewerApiRoute,
  isViewerSharedReadRoute,
  isViewerOwnDataRoute,
  VIEWER_API_ROUTES,
  VIEWER_OWN_DATA_ROUTES,
  isViewerPage,
} from "@/lib/auth/roles";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Source with comments stripped: a comment naming a forbidden symbol (e.g. "never
 *  touches api_key_vault") must not read as the code doing it. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CONNECTIONS = code(read("app/api/broker-connections/route.ts"));
const CALLBACK = code(read("app/api/kite/callback/route.ts"));
const LOGIN = code(read("app/api/broker-connections/kite/login/route.ts"));
const PAGE = code(read("app/dashboard/connections/page.tsx"));

// Connecting a broker genuinely needs to WRITE and to call a provider, which the
// shared-read contract forbids. Rather than weaken that contract into
// "GET-only-ish", own-data routes are a separate class with their own rules.
// These assert the two classes stay distinct and each keeps its own guarantee.

describe("the two viewer route classes stay distinct", () => {
  it("shared-read routes remain GET-only — the cost guarantee is untouched", () => {
    for (const route of VIEWER_API_ROUTES) {
      expect(route.methods, route.prefix).toEqual(["GET"]);
    }
  });

  it("broker-connections is an own-data route, not a shared-read one", () => {
    expect(isViewerSharedReadRoute("/api/broker-connections", "GET")).toBe(false);
    expect(isViewerOwnDataRoute("/api/broker-connections", "GET")).toBe(true);
    expect(isViewerOwnDataRoute("/api/broker-connections", "POST")).toBe(true);
    expect(isViewerApiRoute("/api/broker-connections", "POST")).toBe(true);
  });

  it("own-data status does not leak onto unrelated routes", () => {
    expect(isViewerOwnDataRoute("/api/admin/access", "POST")).toBe(false);
    expect(isViewerOwnDataRoute("/api/agents/paper-trade", "POST")).toBe(false);
    expect(isViewerOwnDataRoute("/api/broker-connections-admin", "GET")).toBe(false);
  });

  it("own-data routes stay a short, deliberate list", () => {
    // The outbound-call sweep covers the no-cost class only — necessarily, since
    // own-data routes are allowed the provider call it forbids. So this list is
    // the containment: widening it must be a deliberate act that edits a test,
    // never a quiet addition. Each entry writes ONLY rows keyed to the caller.
    // Widened 2026-09-15, deliberately: the per-user watchlist and the user
    // notification/newsletter prefs. Both qualify on the same rule as the
    // entries above — every row they read or write is keyed to the caller's
    // own uid under RLS, and neither calls a provider. They carry none of the
    // owner's book.
    expect(VIEWER_OWN_DATA_ROUTES.map((r) => r.prefix)).toEqual([
      "/api/broker-connections",
      "/api/user-risk/prefs",
      "/api/user-risk/unsubscribe",
      "/api/user-watchlist",
      "/api/user-prefs",
    ]);
  });

  it("the connections page is reachable by a viewer", () => {
    expect(isViewerPage("/dashboard/connections")).toBe(true);
  });
});

describe("connections route acts only on the caller", () => {
  it("takes the user id from the session, never from the request body", () => {
    // A body-supplied user id would let one guest disconnect another's broker.
    expect(CONNECTIONS.includes("getSessionRole()")).toBe(true);
    expect(/body\?\.user_id|body\.userId/.test(CONNECTIONS), "reads a user id from the body").toBe(false);
    expect(CONNECTIONS.includes("disconnectGuestCredential(userId, broker)")).toBe(true);
  });

  it("never returns a credential", () => {
    expect(CONNECTIONS.includes("ciphertext"), "route mentions ciphertext").toBe(false);
    expect(CONNECTIONS.includes("decryptCredential"), "route decrypts for a browser").toBe(false);
  });

  it("refuses anything but disconnect", () => {
    expect(CONNECTIONS.includes('!== "disconnect"')).toBe(true);
  });
});

describe("the shared Kite callback routes the token to the right owner", () => {
  it("decides from the SIGNED cookie, not the session", () => {
    // Zerodha registers one redirect URL per app, so guests share this callback.
    // A session can be absent on a redirect; falling back to the owner path
    // would let a guest's token overwrite the owner's vault entry.
    expect(CALLBACK.includes("verified.verifier?.startsWith(GUEST_VERIFIER_PREFIX)")).toBe(true);
    const guestBlock = CALLBACK.slice(CALLBACK.indexOf("if (guestUserId) {"), CALLBACK.indexOf("await storeAccessToken"));
    expect(guestBlock.includes("getSessionRole"), "guest branch trusts the session").toBe(false);
  });

  it("a guest connection never writes the owner's vault or trading account", () => {
    const guestBlock = CALLBACK.slice(CALLBACK.indexOf("if (guestUserId) {"), CALLBACK.indexOf("await storeAccessToken"));
    for (const forbidden of ["api_key_vault", "storeAccessToken", "broker_accounts", "strategy_config"]) {
      expect(guestBlock.includes(forbidden), `guest branch touches ${forbidden}`).toBe(false);
    }
    expect(guestBlock.includes("storeGuestCredential")).toBe(true);
  });

  it("the owner's own flow is unchanged — its verifier is empty, so it takes the old path", () => {
    expect(CALLBACK.includes("await storeAccessToken(svc, result.accessToken);")).toBe(true);
    expect(read("app/api/kite/login/route.ts").includes('verifier: ""')).toBe(true);
  });

  it("the guest login binds the user id into the signed cookie", () => {
    expect(LOGIN.includes("signOAuthCookie(")).toBe(true);
    expect(LOGIN.includes("`${GUEST_VERIFIER_PREFIX}${userId}`")).toBe(true);
  });
});

describe("staleness is loud, as the owner required", () => {
  it("a stale connection renders a banner, not a quiet status dot", () => {
    expect(PAGE.includes("Your figures are out of date.")).toBe(true);
    expect(PAGE.includes("c.stale && c.staleReason")).toBe(true);
  });

  it("offers Reconnect when stale rather than leaving the user to guess", () => {
    expect(PAGE.includes('"Reconnect"')).toBe(true);
  });

  it("tells the user plainly that access is read-only", () => {
    expect(/read-only/i.test(PAGE)).toBe(true);
    expect(PAGE.includes("nothing can be bought") || /bought,\s*\n?\s*sold or cancelled/i.test(PAGE)).toBe(true);
  });
});
