import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { getKiteHoldings, kiteGet } from "@/lib/kite";
import { indiaGttCoverage, type KiteGttForCoverage } from "@/lib/trading/india-gtt-coverage";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const [holdingsResult, gttResult] = await Promise.all([
    getKiteHoldings().catch(() => ({ ok: false, data: undefined, error: "Kite holdings read failed" })),
    kiteGet("/gtt/triggers").catch(() => ({ ok: false, data: undefined, error: "Kite GTT read failed" })),
  ]);
  const holdingsValid = holdingsResult.ok && Array.isArray(holdingsResult.data)
    && holdingsResult.data.every((row: any) => row && typeof row === "object"
      && typeof row.tradingsymbol === "string" && row.tradingsymbol.trim().length > 0
      && ["NSE", "BSE"].includes(String(row.exchange).toUpperCase())
      && row.quantity != null && row.quantity !== "" && Number.isFinite(Number(row.quantity)) && Number(row.quantity) >= 0);
  if (!holdingsValid) {
    const error = "Kite holdings unavailable or malformed; Guardian coverage is unknown. Reconnect Kite if its session expired.";
    await reportIssue({ issueKey: "guardian-coverage:india", severity: "warn", category: "broker", title: "India Guardian holdings cannot be verified", detail: error });
    return NextResponse.json({ error, holdingsAvailable: false, gttAvailable: false }, { status: 503 });
  }

  const holdings = (holdingsResult.data ?? [])
    .map((row: any) => ({
      symbol: `${String(row.tradingsymbol ?? "").toUpperCase()}.${String(row.exchange).toUpperCase() === "BSE" ? "BO" : "NS"}`,
      qty: Number(row.quantity ?? 0),
      currentPrice: row.last_price != null && Number.isFinite(Number(row.last_price)) && Number(row.last_price) > 0 ? Number(row.last_price) : null,
      averagePrice: row.average_price != null && Number.isFinite(Number(row.average_price)) ? Number(row.average_price) : null,
    }))
    .filter((row: any) => row.symbol.length > 3 && Number.isFinite(row.qty) && row.qty > 0);

  const gttValid = gttResult.ok && Array.isArray(gttResult.data)
    && gttResult.data.every((row: any) => row && typeof row === "object"
      && typeof row.status === "string" && row.condition && typeof row.condition === "object"
      && typeof row.condition.tradingsymbol === "string" && Array.isArray(row.orders));
  if (!gttValid) {
    const error = "Kite GTT book unavailable or malformed; stop coverage cannot be verified.";
    await reportIssue({ issueKey: "guardian-coverage:india", severity: "warn", category: "broker", title: "India Guardian GTT coverage cannot be verified", detail: error });
    return NextResponse.json({
      asOf: new Date().toISOString(), holdingsAvailable: true, gttAvailable: false,
      error,
      positions: holdings.map((holding: any) => ({ ...holding, protection: { state: "unknown", reason: "Kite GTT status could not be verified." } })),
    });
  }

  const triggers = gttResult.data as KiteGttForCoverage[];
  await resolveIssue("guardian-coverage:india");
  return NextResponse.json({
    asOf: new Date().toISOString(), holdingsAvailable: true, gttAvailable: true,
    positions: holdings.map((holding: any) => ({ ...holding, protection: indiaGttCoverage(holding, triggers) })),
  });
}
