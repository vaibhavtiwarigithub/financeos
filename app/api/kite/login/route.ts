import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getKiteCreds, kiteLoginUrl } from "@/lib/kite";

export const dynamic = "force-dynamic";

// Kicks off the Kite daily login — redirects the browser to Zerodha's auth
// page. After the user authorizes, Kite redirects back to the app-configured
// redirect URL (/api/kite/callback) with a request_token.
export async function GET() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", process.env.APP_BASE_URL ?? "http://localhost:3000"));

  const { apiKey } = await getKiteCreds();
  if (!apiKey) {
    return NextResponse.redirect(new URL("/dashboard/settings?kite=missing_key", process.env.APP_BASE_URL ?? "http://localhost:3000"));
  }
  return NextResponse.redirect(kiteLoginUrl(apiKey));
}
