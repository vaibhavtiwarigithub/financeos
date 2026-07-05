import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchNseInsider } from "@/lib/nse-data";

export const dynamic = "force-dynamic";

// SEBI insider (PIT) disclosures from NSE. NSE calls are server-side only
// (cookie handshake + browser headers), never from the browser. Fails soft:
// an empty list means NSE blocked us → available:false so the UI shows the
// honest "unavailable" note instead of an empty table.
export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const symbol = req.nextUrl.searchParams.get("symbol") ?? undefined;
  const trades = await fetchNseInsider(symbol);

  return NextResponse.json({
    trades,
    source: "nse",
    available: trades.length > 0,
  });
}
