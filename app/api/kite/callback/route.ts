import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getKiteCreds, exchangeRequestToken, storeAccessToken } from "@/lib/kite";

export const dynamic = "force-dynamic";

// Kite redirects here after login with ?request_token=...&action=login&status=success.
// We exchange it for a daily access_token and store it, then bounce back to
// Settings with a status flag. No user-auth gate here: Kite drives this
// redirect and the request_token is single-use + checksum-signed, so it can't
// be forged; the exchange fails without the correct api_secret.
export async function GET(req: NextRequest) {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const requestToken = req.nextUrl.searchParams.get("request_token");
  const status = req.nextUrl.searchParams.get("status");

  if (!requestToken || status === "error") {
    return NextResponse.redirect(new URL("/dashboard/settings?kite=login_failed", base));
  }

  const svc = createServiceClient();
  const { apiKey, apiSecret } = await getKiteCreds(svc);
  if (!apiKey || !apiSecret) {
    return NextResponse.redirect(new URL("/dashboard/settings?kite=missing_key", base));
  }

  const result = await exchangeRequestToken(apiKey, apiSecret, requestToken);
  if (!result.ok) {
    return NextResponse.redirect(new URL(`/dashboard/settings?kite=exchange_failed`, base));
  }

  await storeAccessToken(svc, result.accessToken);
  return NextResponse.redirect(new URL("/dashboard/settings?kite=connected", base));
}
