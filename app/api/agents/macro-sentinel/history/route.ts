import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();
  const { data: regimes } = await svc
    .from("macro_regime")
    .select("*")
    .order("week_of", { ascending: false })
    .limit(52); // 1 year

  const { data: latest_signals } = await svc
    .from("macro_signals")
    .select("*")
    .eq("week_of", regimes?.[0]?.week_of ?? new Date().toLocaleDateString("en-CA"))
    .order("week_of", { ascending: false });

  return NextResponse.json({ regimes: regimes ?? [], latest_signals: latest_signals ?? [] });
}
