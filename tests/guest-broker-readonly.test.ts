import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { credentialFreshness, istCalendarDate } from "@/lib/brokers/guest-credentials";

const ROOT = resolve(__dirname, "..");
const READONLY = readFileSync(resolve(ROOT, "lib/brokers/guest-readonly.ts"), "utf8");
const CREDS = readFileSync(resolve(ROOT, "lib/brokers/guest-credentials.ts"), "utf8");

/**
 * Code with comments removed.
 *
 * The forbidden-symbol checks below must inspect what the module actually
 * REFERENCES, not what it explains. The file deliberately names the order-capable
 * helpers in a comment to record why they are excluded; scanning raw text would
 * make documenting that impossible.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const READONLY_CODE = code(READONLY);

// The owner accepted the daily Zerodha login (2026-09-14, option a) ON CONDITION
// that staleness is shown loudly rather than a stale number being passed off as
// current. These assert the rule that makes that possible.

describe("credential freshness — the daily Kite expiry", () => {
  const IST_MORNING = new Date("2026-09-14T04:00:00Z"); // 09:30 IST on the 14th

  it("a Zerodha token issued today is usable", () => {
    const { fresh, reason } = credentialFreshness("kite", "2026-09-14T03:50:00Z", null, IST_MORNING);
    expect(fresh).toBe(true);
    expect(reason).toBeNull();
  });

  it("a Zerodha token from yesterday is NOT usable, and says why in plain language", () => {
    const { fresh, reason } = credentialFreshness("kite", "2026-09-13T05:00:00Z", null, IST_MORNING);
    expect(fresh).toBe(false);
    expect(reason).toMatch(/expire at the end of each trading day/i);
    expect(reason).toMatch(/last connected day/i); // says the figures are old, not just "error"
  });

  it("uses the IST day boundary, not UTC", () => {
    // 2026-09-13T20:00Z is already the 14th in IST (01:30). A UTC-based
    // comparison would wrongly call this yesterday's token.
    const connectedIstSameDay = "2026-09-13T20:00:00Z";
    expect(istCalendarDate(new Date(connectedIstSameDay))).toBe("2026-09-14");
    expect(credentialFreshness("kite", connectedIstSameDay, null, IST_MORNING).fresh).toBe(true);
  });

  it("an explicit expiry in the past wins for any broker", () => {
    const r = credentialFreshness("robinhood", "2026-09-14T03:00:00Z", "2026-09-14T03:30:00Z", IST_MORNING);
    expect(r.fresh).toBe(false);
    expect(r.reason).toMatch(/expired/i);
  });

  it("Robinhood without an explicit expiry is treated as live", () => {
    expect(credentialFreshness("robinhood", "2026-09-01T00:00:00Z", null, IST_MORNING).fresh).toBe(true);
  });

  it("a missing Zerodha connection is stale, never quietly fresh", () => {
    expect(credentialFreshness("kite", null, null, IST_MORNING).fresh).toBe(false);
  });
});

// The capability boundary. A guest client must have no order method ON it —
// not an unused one, not a guarded one.
describe("guest client is read-only by construction", () => {
  it("exposes holdings and nothing else", () => {
    const type = READONLY.slice(
      READONLY.indexOf("export type GuestReadOnlyClient"),
      READONLY.indexOf("export type GuestHolding"),
    );
    expect(type).toContain("holdings:");
    for (const forbidden of ["order", "place", "cancel", "modify", "sell", "buy", "exit"]) {
      expect(type.toLowerCase().includes(forbidden), `client type exposes "${forbidden}"`).toBe(false);
    }
  });

  it("never reaches an order-capable helper", () => {
    // kitePost / kiteDelete place and cancel orders; the MCP order tools do the
    // same on Robinhood. None may be imported here.
    for (const forbidden of ["kitePost", "kiteDelete", "place_equity_order", "cancel_equity_order", "place_crypto_order"]) {
      expect(READONLY_CODE.includes(forbidden), `guest client references ${forbidden}`).toBe(false);
    }
  });

  it("only ever issues a GET to the provider", () => {
    expect(/method:\s*["']POST["']/i.test(READONLY_CODE), "guest client issues a POST").toBe(false);
    expect(/method:\s*["']DELETE["']/i.test(READONLY_CODE), "guest client issues a DELETE").toBe(false);
  });

  it("refuses rather than falling back to the owner's credential", () => {
    // An unsupported broker silently using the global vault is precisely the
    // leak this feature exists to prevent.
    expect(READONLY_CODE.includes("api_key_vault"), "guest client touches the owner's vault").toBe(false);
    expect(READONLY_CODE.includes('reason: "unsupported"')).toBe(true);
  });
});

describe("credential handling", () => {
  it("a revoked grant yields no token — one revocation, both effects", () => {
    expect(CREDS.includes("access_revoked")).toBe(true);
    expect(CREDS.includes("hasActiveAccess")).toBe(true);
  });

  it("a stale credential yields no token, so it cannot be used by accident", () => {
    expect(/if \(!freshness\.fresh\) return \{ token: null/.test(CREDS)).toBe(true);
  });

  it("disconnect clears the ciphertext rather than only flagging the row", () => {
    expect(/ciphertext:\s*""/.test(CREDS)).toBe(true);
  });

  it("stores only ciphertext — the plaintext token is never written to a column", () => {
    expect(CREDS.includes("ciphertext: encryptCredential(")).toBe(true);
    expect(/token:\s*params\.token/.test(CREDS), "raw token written to a column").toBe(false);
  });
});
