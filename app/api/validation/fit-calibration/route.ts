import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fitAndStoreCalibration } from "@/lib/validation/calibration";

export const dynamic = "force-dynamic";

// Phase 2 learning-core: weekly refit of the calibrated P(win) model per market.
// Dormant until 60+ matured labeled observations exist for a market (fitCalibration
// returns null below that, and fitAndStoreCalibration reports insufficient_data).
export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const markets: ("us" | "india")[] = ["us", "india"];
  const results: Record<string, any> = {};
  for (const market of markets) {
    try {
      results[market] = await fitAndStoreCalibration(supabase, market, 10);
    } catch (err) {
      results[market] = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return NextResponse.json({ success: true, results });
}
