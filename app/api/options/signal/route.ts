import { NextRequest, NextResponse } from "next/server";
import { fetchOptionsSignal } from "@/lib/options-signal";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol")?.trim().toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  const signal = await fetchOptionsSignal(symbol);
  if (!signal) return NextResponse.json({ error: "No options data" }, { status: 404 });
  return NextResponse.json(signal);
}
