import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Weekly cron: count closed evaluable paper_trades per market.
// If >= 20, surface system_issue 'p1_gate_ready:<market>' → shows in System Health card.
// If < 20, auto-resolve the issue (no noise while accumulating).
//
// Schedule: Sunday 02:00 UTC (both markets closed)
// curl -X POST "https://<host>/api/agents/evaluation/p1-gate/cron" \
//   -H "x-cron-secret: <CRON_SECRET>"

const P1_THRESHOLD = 20;
const MARKETS = ["us", "india"] as const;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const results: Record<string, { count: number; gate: boolean }> = {};

  for (const market of MARKETS) {
    const { count, error } = await supabase
      .from("paper_trades")
      .select("id", { count: "exact", head: true })
      .eq("market", market)
      .not("closed_at", "is", null)
      .neq("excluded_from_learning", true);

    if (error) {
      console.error(`[p1-gate-cron] count failed for ${market}:`, error.message);
      results[market] = { count: -1, gate: false };
      continue;
    }

    const n = count ?? 0;
    const issueKey = `p1_gate_ready:${market}`;

    if (n >= P1_THRESHOLD) {
      await reportIssue({
        issueKey,
        severity: "info",
        category: "evaluation",
        title: `P1 gate open — ${market.toUpperCase()} (${n} closed trades)`,
        detail: `${n} evaluable closed trades in paper_trades for market=${market} (threshold: ${P1_THRESHOLD}). ` +
          `Ready to build opportunity-level IC, walk-forward folds, and observation_labels. ` +
          `Resolve this issue once P1 is built.`,
      });
    } else {
      await resolveIssue(issueKey);
    }

    results[market] = { count: n, gate: n >= P1_THRESHOLD };
  }

  return NextResponse.json({ ok: true, threshold: P1_THRESHOLD, markets: results });
}
