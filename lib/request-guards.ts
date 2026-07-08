import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";

// Allowed hosts. DNS rebinding attack arrives with Host: evil.com — this kills
// it. Localhost for dev; the deployed host comes from APP_BASE_URL so the guard
// works on Vercel instead of tempting a "just drop the guard" fix in prod.
const ALLOWED_HOSTS = new Set(["localhost:3000", "localhost:3001", "127.0.0.1:3000"]);

// Allowed origins for state-mutating requests (CSRF protection).
// Browsers always send Origin on cross-origin POST — attacker's origin won't match.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
]);

// Fold in the deployed origin/host from APP_BASE_URL (e.g.
// "https://financeos.vercel.app"), if set, so live order clicks aren't 403'd.
const APP_BASE_URL = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
if (APP_BASE_URL) {
  try {
    const u = new URL(APP_BASE_URL);
    ALLOWED_ORIGINS.add(u.origin);
    ALLOWED_HOSTS.add(u.host);
  } catch { /* malformed env — ignore, localhost still allowed */ }
}

/**
 * Call at the top of any order-placing API route.
 * Returns a 403 NextResponse if the request is suspicious, null if OK.
 *
 * Blocks:
 *  - DNS rebinding (Host header mismatch)
 *  - CSRF from malicious tabs (Origin mismatch on non-GET)
 *  - Cron requests bypass this via x-cron-secret — they never come from a browser
 */
export function guardOrderRequest(req: NextRequest): NextResponse | null {
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");

  // Host validation applies to EVERYONE, including cron — DNS rebinding is
  // always blocked (a cron request still arrives at the real deployed host,
  // which is in ALLOWED_HOSTS via APP_BASE_URL).
  if (!ALLOWED_HOSTS.has(host)) {
    console.warn(`[security] Blocked request: invalid Host "${host}"`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Cron-triggered requests (internal server→server) legitimately carry no
  // browser Origin — they skip ONLY the Origin/CSRF check below, not the Host
  // check above. Timing-safe + fails closed on unset/empty CRON_SECRET. The
  // live-order Gateway also calls requireOwner() BEFORE this guard, so this
  // cron path can never by itself place an order.
  if (verifyCronSecret(req)) return null;

  // Origin validation on non-GET requests — blocks CSRF. A MISSING Origin no
  // longer passes: a non-cron non-GET request must present an allowlisted
  // Origin (browsers always do on cross-site POST; a cookie-replaying non-
  // browser client that omits Origin is now rejected here).
  if (req.method !== "GET" && (origin === null || !ALLOWED_ORIGINS.has(origin))) {
    console.warn(`[security] Blocked request: invalid Origin "${origin}"`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return null;
}
