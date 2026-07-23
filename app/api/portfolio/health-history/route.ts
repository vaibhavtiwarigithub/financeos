// Account Health history — read API.
//
// GET /api/portfolio/health-history?market=us|india
//
// Owner-gated (authenticated user), then a service client reads the account-level
// rollups from account_risk_snapshots. Health = 100 - riskScore: the SAME 0-100
// engine already computed daily, framed so higher = calmer. Returns, per account:
//   • a per-day health/risk series (deduped to the last snapshot of each day),
//   • Δ health vs the prior distinct day (why-it-moved anchor),
//   • the single most-severe open warning as `topAction` (from metrics.warnings).
//
// History only goes back to 2026-07-11 (when the engine began logging); the series
// is however many days exist, not a fixed window. It accrues over time.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// 605420660 is the ONLY account Kairos may ever trade; every other Robinhood
// account is read-only. Mirrors isReadOnlyAccount in PortfolioRiskPage.
function isReadOnly(broker: string, accountId: string): boolean {
  return broker === "robinhood" && accountId !== "605420660";
}

interface SnapshotRow {
  account_id: string;
  account_label: string | null;
  broker: string;
  currency: string;
  total_value: number | null;
  metrics: Record<string, unknown> | null;
  data_confidence: number | null;
  captured_on: string;
  created_at: string;
}

type Warning = { message?: string; action?: string; severity?: string };

const SEVERITY_RANK: Record<string, number> = { critical: 3, warn: 2, info: 1 };

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("account_risk_snapshots")
    .select("account_id,account_label,broker,currency,total_value,metrics,data_confidence,captured_on,created_at")
    .eq("market", market)
    .order("captured_on", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as SnapshotRow[];

  // Group by account_id (the stable key — labels were renamed mid-series).
  const byAccount = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const list = byAccount.get(r.account_id) ?? [];
    list.push(r);
    byAccount.set(r.account_id, list);
  }

  const accounts = Array.from(byAccount.entries()).map(([accountId, list]) => {
    // Dedup to the LAST snapshot of each captured_on (rows already sorted by
    // captured_on then created_at, so the last write for a day wins).
    const byDay = new Map<string, SnapshotRow>();
    for (const r of list) byDay.set(r.captured_on, r);
    const days = Array.from(byDay.values());

    const series = days.map((r) => {
      const m = (r.metrics ?? {}) as Record<string, unknown>;
      const risk = m.riskScore == null ? null : Number(m.riskScore);
      return {
        date: r.captured_on,
        risk,
        health: risk == null ? null : 100 - risk,
        label: typeof m.riskLabel === "string" ? m.riskLabel : null,
      };
    });

    const last = days[days.length - 1];
    const lastMetrics = (last?.metrics ?? {}) as Record<string, unknown>;
    const latestRisk = lastMetrics.riskScore == null ? null : Number(lastMetrics.riskScore);
    const latestHealth = latestRisk == null ? null : 100 - latestRisk;

    // Δ health vs the prior distinct day that has a value.
    let deltaVsPrior: number | null = null;
    const withVals = series.filter((s) => s.health != null);
    if (withVals.length >= 2) {
      const a = withVals[withVals.length - 1].health as number;
      const b = withVals[withVals.length - 2].health as number;
      deltaVsPrior = a - b;
    }

    // Top action = the most-severe open warning on the latest snapshot.
    const warnings: Warning[] = Array.isArray(lastMetrics.warnings) ? (lastMetrics.warnings as Warning[]) : [];
    let topAction: Warning | null = null;
    for (const w of warnings) {
      if (topAction == null || (SEVERITY_RANK[w.severity ?? "info"] ?? 0) > (SEVERITY_RANK[topAction.severity ?? "info"] ?? 0)) {
        topAction = w;
      }
    }

    // Label the account by its most RECENT label (renames should win).
    const label = last?.account_label
      ?? `${last?.broker ?? "account"} ••••${accountId.slice(-4)}`;

    return {
      accountId,
      label,
      broker: last?.broker ?? "",
      currency: last?.currency ?? (market === "india" ? "₹" : "$"),
      readOnly: isReadOnly(last?.broker ?? "", accountId),
      totalValue: last?.total_value == null ? null : Number(last.total_value),
      dataConfidence: last?.data_confidence == null ? null : Number(last.data_confidence),
      latestHealth,
      latestRisk,
      latestLabel: typeof lastMetrics.riskLabel === "string" ? lastMetrics.riskLabel : null,
      deltaVsPrior,
      series,
      topAction: topAction
        ? { message: topAction.message ?? "", action: topAction.action ?? "", severity: topAction.severity ?? "info" }
        : null,
    };
  });

  // Order: worst latest health first (most attention), unknown health last.
  accounts.sort((a, b) => (a.latestHealth ?? 999) - (b.latestHealth ?? 999));

  const firstDay = rows.length ? rows[0].captured_on : null;
  return NextResponse.json({ market, firstDay, accounts });
}
