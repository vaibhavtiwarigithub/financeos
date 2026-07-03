import { NextRequest, NextResponse } from "next/server";

// Allowed hosts for localhost-only operation.
// DNS rebinding attack arrives with Host: evil.com — this check kills it.
const ALLOWED_HOSTS = new Set(["localhost:3000", "localhost:3001", "127.0.0.1:3000"]);

// Allowed origins for state-mutating requests (CSRF protection).
// Browsers always send Origin on cross-origin POST — attacker's origin won't match.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
]);

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
  const cronSecret = req.headers.get("x-cron-secret");

  // Cron-triggered requests (internal server→server) skip browser-level checks.
  // They are already validated by cron secret in the route handler.
  if (cronSecret === process.env.CRON_SECRET) return null;

  // Host header validation — blocks DNS rebinding
  if (!ALLOWED_HOSTS.has(host)) {
    console.warn(`[security] Blocked request: invalid Host "${host}"`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Origin validation on non-GET requests — blocks CSRF
  if (req.method !== "GET" && origin !== null && !ALLOWED_ORIGINS.has(origin)) {
    console.warn(`[security] Blocked request: invalid Origin "${origin}"`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return null;
}
