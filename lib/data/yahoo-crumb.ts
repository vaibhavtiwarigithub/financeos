// Yahoo session cookie + crumb, shared by every Yahoo endpoint that requires one.
//
// Extracted from lib/india-data.ts unchanged so the US screener can reuse the
// same cached handshake rather than opening a second one. Two independent crumb
// caches would double the handshake traffic against a host that rate-limits.

let _crumb: { cookie: string; crumb: string; at: number } | null = null;
const CRUMB_TTL_MS = 30 * 60 * 1000;

export async function getCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  if (_crumb && Date.now() - _crumb.at < CRUMB_TTL_MS) return _crumb;
  try {
    // Grab a session cookie, then a crumb tied to it.
    const cookieRes = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    const setCookie = cookieRes.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] || "";
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.includes("<")) return null;
    _crumb = { cookie, crumb, at: Date.now() };
    return _crumb;
  } catch {
    return null;
  }
}

/** Test-only: drop the cached crumb so a test cannot leak state into the next. */
export function __resetCrumbCache(): void {
  _crumb = null;
}
