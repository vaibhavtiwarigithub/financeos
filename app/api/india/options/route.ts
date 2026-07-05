import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchNseOptionChain } from "@/lib/nse-data";

export const dynamic = "force-dynamic";

// NSE option chain (PCR + top OI strikes) = the free stand-in for "options flow".
// Server-side only (cookie handshake + browser headers). Fails soft: a null flow
// means NSE blocked us → available:false so the UI falls back to the note.
export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const symbol = req.nextUrl.searchParams.get("symbol") ?? "NIFTY";
  const flow = await fetchNseOptionChain(symbol);

  return NextResponse.json({
    ...(flow ?? {}),
    available: flow != null,
  });
}
