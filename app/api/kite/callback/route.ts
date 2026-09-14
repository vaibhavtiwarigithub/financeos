import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getKiteCreds, exchangeRequestToken, storeAccessToken } from "@/lib/kite";
import { verifyOAuthCookie } from "@/lib/robinhood-mcp";
import { storeGuestCredential } from "@/lib/brokers/guest-credentials";
import { GUEST_VERIFIER_PREFIX } from "@/app/api/broker-connections/kite/login/route";

export const dynamic = "force-dynamic";
const STATE_COOKIE = "kite_oauth_state";

// Kite redirects here after login with ?request_token=...&action=login&status=success.
// We exchange it for a daily access_token and store it, then bounce back to
// Settings with a status flag. No user-auth gate here: Kite itself drives
// this redirect. Kite's login flow has no state param to echo back, so CSRF
// protection instead requires a signed, single-use, short-lived cookie set
// by the owner-gated /api/kite/login — its presence proves this browser
// recently initiated the login itself; a forged/replayed hit on this route
// without that cookie is rejected before the token exchange even runs.
export async function GET(req: NextRequest) {
  // Redirect back to the SAME origin this callback ran on (Vercel in prod), so we
  // never hard-bounce to localhost when APP_BASE_URL isn't set. APP_BASE_URL still
  // wins if explicitly configured. NOTE: the domain Kite redirects TO is set in the
  // Zerodha developer console ("Redirect URL"), NOT here — it must be
  // https://<your-app>/api/kite/callback, or the whole flow lands on the wrong host.
  const base = process.env.APP_BASE_URL || req.nextUrl.origin;
  const requestToken = req.nextUrl.searchParams.get("request_token");
  const status = req.nextUrl.searchParams.get("status");

  if (!requestToken || status === "error") {
    return NextResponse.redirect(new URL("/dashboard/settings?kite=login_failed", base));
  }

  const stateCookie = req.cookies.get(STATE_COOKIE)?.value;
  const verified = verifyOAuthCookie(stateCookie);
  if (!verified) {
    return NextResponse.redirect(new URL("/dashboard/settings?kite=login_expired", base));
  }

  const svc = createServiceClient();
  const { apiKey, apiSecret } = await getKiteCreds(svc);
  if (!apiKey || !apiSecret) {
    return NextResponse.redirect(new URL("/dashboard/settings?kite=missing_key", base));
  }

  // WHOSE login was this?
  //
  // Zerodha registers one redirect URL per app, so guests share this callback.
  // The answer comes from the SIGNED state cookie, not from the session: a
  // session can be absent on a redirect, and falling back to the owner path
  // would let a guest's token overwrite the owner's vault entry. The cookie is
  // HMAC-signed and compared in constant time, so a guest cannot forge the
  // owner path and the owner's own flow is unchanged (its verifier is empty).
  const guestUserId = verified.verifier?.startsWith(GUEST_VERIFIER_PREFIX)
    ? verified.verifier.slice(GUEST_VERIFIER_PREFIX.length)
    : null;

  const result = await exchangeRequestToken(apiKey, apiSecret, requestToken);
  if (!result.ok) {
    const failPath = guestUserId ? "/dashboard/connections?kite=exchange_failed" : "/dashboard/settings?kite=exchange_failed";
    return NextResponse.redirect(new URL(failPath, base));
  }

  if (guestUserId) {
    // Guest path: encrypted, per-user, read-only. Never touches api_key_vault,
    // broker_accounts or strategy_config — a guest connection must not seed the
    // owner's trading account or allowlist.
    const stored = await storeGuestCredential({
      userId: guestUserId,
      broker: "kite",
      token: result.accessToken,
    });
    const res = NextResponse.redirect(
      new URL(stored.ok ? "/dashboard/connections?kite=connected" : "/dashboard/connections?kite=store_failed", base),
    );
    res.cookies.delete(STATE_COOKIE);
    return res;
  }

  await storeAccessToken(svc, result.accessToken);

  // Seed the account allowlist + active trading account from the real Kite
  // user_id returned by the exchange (Kite has no numeric account_number
  // concept — the connected user IS the single tradable account).
  if (result.userId) {
    await svc.from("broker_accounts").upsert({
      broker: "kite", market: "india", account_number: result.userId,
      label: "Zerodha Kite (connected account)", role: "trading",
    }, { onConflict: "broker,account_number" });
    await svc.from("strategy_config").update({ active_account_india: result.userId }).not("id", "is", null);
  }

  const res = NextResponse.redirect(new URL("/dashboard/settings?kite=connected", base));
  res.cookies.delete(STATE_COOKIE);
  return res;
}
