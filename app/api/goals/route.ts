import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { computeGoalFeasibility } from "@/lib/goals/feasibility";

export const dynamic = "force-dynamic";

const START_NAV: Record<string, number> = { us: 10000, india: 1000000 };

export async function POST(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const market = body.market === "india" ? "india" : "us";
  const targetReturnPct = Number(body.target_return_pct);
  const horizonDays = Number(body.horizon_days);
  if (!Number.isFinite(targetReturnPct) || targetReturnPct <= 0) {
    return NextResponse.json({ error: "target_return_pct must be a positive number" }, { status: 400 });
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 3650) {
    return NextResponse.json({ error: "horizon_days must be 1–3650" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: pool } = await svc.from("paper_portfolio").select("nav").eq("market", market).limit(1).maybeSingle();
  const startNav = pool?.nav != null ? Number(pool.nav) : (START_NAV[market] ?? 10000);

  // Cancel any other active goal for this market — one active goal at a time keeps the dashboard card unambiguous.
  await svc.from("trading_goals").update({ status: "canceled" }).eq("market", market).eq("status", "active");

  const { data: goal, error } = await svc.from("trading_goals").insert({
    market, target_return_pct: targetReturnPct, horizon_days: horizonDays, start_nav: startNav, note: body.note ?? null,
    start_date: new Date().toISOString().slice(0, 10), // explicit, not relying solely on the column's DEFAULT CURRENT_DATE
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, goal });
}

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();

  const { data: goal } = await svc.from("trading_goals").select("*").eq("market", market).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!goal) return NextResponse.json({ goal: null });

  const [{ data: pool }, { data: perf }] = await Promise.all([
    svc.from("paper_portfolio").select("nav").eq("market", market).limit(1).maybeSingle(),
    svc.from("paper_performance").select("date, nav").eq("market", market).gte("date", new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)).order("date", { ascending: true }),
  ]);

  const currentNav = pool?.nav != null ? Number(pool.nav) : Number(goal.start_nav);
  const perfRows = (perf ?? []) as { date: string; nav: number }[];
  let realizedDailyPct = NaN;
  if (perfRows.length >= 2) {
    const rets: number[] = [];
    for (let i = 1; i < perfRows.length; i++) {
      const prev = Number(perfRows[i - 1].nav);
      const cur = Number(perfRows[i].nav);
      if (prev > 0) rets.push(((cur - prev) / prev) * 100);
    }
    if (rets.length > 0) realizedDailyPct = rets.reduce((a, b) => a + b, 0) / rets.length;
  }

  const { requiredDailyPct, feasibility } = computeGoalFeasibility({
    targetPct: Number(goal.target_return_pct),
    horizonDays: Number(goal.horizon_days),
    realizedDailyPct,
  });

  const progressPct = ((currentNav - Number(goal.start_nav)) / Number(goal.start_nav)) * 100;
  const daysElapsed = Math.floor((Date.now() - new Date(goal.start_date).getTime()) / 86400_000);
  const daysLeft = Math.max(0, Number(goal.horizon_days) - daysElapsed);
  const expectedProgressPct = (daysElapsed / Number(goal.horizon_days)) * Number(goal.target_return_pct);
  // daysElapsed === 0 makes expectedProgressPct 0, which made a same-day-created
  // goal trivially "on track" with zero real signal. Require at least 1 elapsed
  // day before claiming on-track either way.
  const onTrack = daysElapsed > 0 ? progressPct >= expectedProgressPct * 0.85 : null;

  let status = goal.status;
  if (status === "active") {
    if (progressPct >= Number(goal.target_return_pct)) status = "achieved";
    else if (daysLeft <= 0) status = "missed";
    if (status !== goal.status) await svc.from("trading_goals").update({ status }).eq("id", goal.id);
  }

  return NextResponse.json({
    goal: { ...goal, status },
    currentNav, progressPct, requiredDailyPct, realizedDailyPct: Number.isFinite(realizedDailyPct) ? realizedDailyPct : null,
    feasibility, onTrack, daysLeft, daysElapsed,
  });
}
