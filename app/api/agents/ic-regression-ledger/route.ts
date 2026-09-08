// Stage A — score->return correlation drift detector (owner-approved
// 2026-09-08). DETECTION ONLY, not causal attribution: this route answers
// "did a dimension's rank IC change after code_version X", never "did X cause
// it" — see lib/learning/ic-regression-alert.ts header. Read-only: no score,
// weight, threshold, eligibility, sizing, or broker path reads these records.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { DIAGNOSTIC_HORIZONS } from "@/lib/learning/dimension-diagnostics";
import {
  applyMultipleComparisonsControl,
  buildCodeVersionIcLedger,
  loadCodeVersionObservations,
  type CodeVersionCell,
  type Market,
} from "@/lib/learning/code-version-ic";
import { detectRegressions, reconcileRegressionAlerts } from "@/lib/learning/ic-regression-alert";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function marketFrom(request: NextRequest): Market | null {
  const value = new URL(request.url).searchParams.get("market");
  return value === "us" || value === "india" ? value : null;
}

function horizonsFrom(request: NextRequest): readonly number[] {
  const raw = new URL(request.url).searchParams.get("horizon");
  const parsed = raw == null ? null : Number(raw);
  return parsed != null && DIAGNOSTIC_HORIZONS.includes(parsed as (typeof DIAGNOSTIC_HORIZONS)[number])
    ? [parsed]
    : DIAGNOSTIC_HORIZONS;
}

async function buildLedger(svc: any, market: Market, horizons: readonly number[]): Promise<CodeVersionCell[]> {
  const cells: CodeVersionCell[] = [];
  for (const horizonDays of horizons) {
    const observations = await loadCodeVersionObservations(svc, market, horizonDays);
    cells.push(...buildCodeVersionIcLedger(market, horizonDays, observations));
  }
  return applyMultipleComparisonsControl(cells);
}

// GET — read-only ledger + a pure (non-writing) regression pass, for the
// dashboard panel and for ad-hoc inspection. Owner-gated.
export async function GET(request: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const market = marketFrom(request);
  if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const horizons = horizonsFrom(request);
  try {
    const svc = createServiceClient();
    const cells = await buildLedger(svc, market, horizons);
    const regressions = detectRegressions(cells);
    return NextResponse.json({
      market,
      horizons,
      cells,
      regressions,
      influence: "None. Detection only — flags that a dimension's IC changed AFTER a code_version shipped, never that the version caused it. No score, weight, eligibility, sizing, or broker path reads this.",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "ledger build failed" }, { status: 500 });
  }
}

// POST — recomputes the ledger and reconciles agent_alerts for any active
// regression (open/refresh via lib/system-health.ts reportIssue, auto-resolve
// via reconcileIssues). Cron- or owner-triggered, same pattern as
// app/api/agents/dimension-diagnostics/route.ts.
export async function POST(request: NextRequest) {
  const cron = verifyCronSecret(request);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const market = marketFrom(request);
  if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  try {
    const svc = createServiceClient();
    const cells = await buildLedger(svc, market, DIAGNOSTIC_HORIZONS);
    const regressions = await reconcileRegressionAlerts(market, cells, svc);
    return NextResponse.json({ ok: true, market, cellCount: cells.length, regressions, influence: "None" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "ledger reconcile failed" }, { status: 500 });
  }
}
