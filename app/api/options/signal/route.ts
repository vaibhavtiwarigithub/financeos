import { NextRequest, NextResponse } from "next/server";
import { fetchOptionsSignal } from "@/lib/options-signal";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const signal = await fetchOptionsSignal(symbol);
  if (!signal) return NextResponse.json({ error: "No options data" }, { status: 404 });
  return NextResponse.json(signal);
}
