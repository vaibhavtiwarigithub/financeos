import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getKiteCreds, getAccessToken, kiteGet } from "@/lib/kite";

export const dynamic = "force-dynamic";

// Reports whether Kite is set up (api key present), whether today's token is
// live, and — if live — a one-line profile confirmation from Kite so the user
// sees a real successful call, not just a stored string.
export async function GET() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { apiKey, apiSecret } = await getKiteCreds(svc);
  const { fresh, updatedAt } = await getAccessToken(svc);

  let profile: { user_name?: string; email?: string } | null = null;
  let liveError: string | null = null;
  if (apiKey && fresh) {
    const res = await kiteGet("/user/profile", svc);
    if (res.ok) profile = { user_name: res.data?.user_name, email: res.data?.email };
    else liveError = res.error ?? "profile call failed";
  }

  return NextResponse.json({
    has_key: !!apiKey,
    has_secret: !!apiSecret,
    token_fresh: fresh,
    token_updated_at: updatedAt,
    connected: !!apiKey && fresh && !!profile,
    profile,
    live_error: liveError,
  });
}
