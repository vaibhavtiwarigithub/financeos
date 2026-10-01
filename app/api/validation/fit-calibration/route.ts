import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fitAndStoreCalibration } from "@/lib/validation/calibration";
import { fitAndStoreExecutablePaperCalibration } from "@/lib/validation/executable-paper-calibration";
import { verifyCronSecret } from "@/lib/auth/cron";
import { loadTradingMandate, resolveHorizonDays } from "@/lib/trading-mandate";
import { loadChampionGenome } from "@/lib/validation/genome-live";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Phase 2 learning-core: weekly refit of the calibrated P(win) model per market.
// Dormant until 60+ matured labeled observations exist for a market (fitCalibration
// returns null below that, and fitAndStoreCalibration reports insufficient_data).
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const markets: ("us" | "india")[] = ["us", "india"];
  const results: Record<string, any> = {};
  for (const market of markets) {
    let generic: any;
    try {
      generic = await fitAndStoreCalibration(supabase, market, 10);
    } catch (err) {
      generic = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    let executablePaper: any;
    try {
      const mandate = await loadTradingMandate(supabase, market);
      const genome = await loadChampionGenome(supabase, market);
      const horizon = resolveHorizonDays(mandate, genome.source === "champion" ? genome.genome.horizon_days : null).days;
      executablePaper = await fitAndStoreExecutablePaperCalibration(supabase, market, horizon, mandate.version);
    } catch (err) {
      executablePaper = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    results[market] = { generic, executablePaper };
  }
  return NextResponse.json({ success: true, results });
}
