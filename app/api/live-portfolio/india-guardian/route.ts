import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { getKiteHoldings, kiteGet } from "@/lib/kite";
import { indiaGttCoverage, type KiteGttForCoverage } from "@/lib/trading/india-gtt-coverage";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const [holdingsResult, gttResult] = await Promise.all([
    getKiteHoldings(),
    kiteGet("/gtt/triggers"),
  ]);
  if (!holdingsResult.ok) {
    return NextResponse.json({ error: holdingsResult.error ?? "Kite holdings unavailable", holdingsAvailable: false }, { status: 503 });
  }

  const holdings = (holdingsResult.data ?? [])
    .map((row: any) => ({
      symbol: `${String(row.tradingsymbol ?? "").toUpperCase()}.${String(row.exchange).toUpperCase() === "BSE" ? "BO" : "NS"}`,
      qty: Number(row.quantity ?? 0),
      averagePrice: row.average_price != null && Number.isFinite(Number(row.average_price)) ? Number(row.average_price) : null,
    }))
    .filter((row: any) => row.symbol.length > 3 && Number.isFinite(row.qty) && row.qty > 0);

  if (!gttResult.ok) {
    return NextResponse.json({
      asOf: new Date().toISOString(), holdingsAvailable: true, gttAvailable: false,
      error: gttResult.error ?? "Kite GTT book unavailable",
      positions: holdings.map((holding: any) => ({ ...holding, protection: { state: "unknown", reason: "Kite GTT status could not be verified." } })),
    });
  }

  const triggers = Array.isArray(gttResult.data) ? gttResult.data as KiteGttForCoverage[] : [];
  return NextResponse.json({
    asOf: new Date().toISOString(), holdingsAvailable: true, gttAvailable: true,
    positions: holdings.map((holding: any) => ({ ...holding, protection: indiaGttCoverage(holding, triggers) })),
  });
}
