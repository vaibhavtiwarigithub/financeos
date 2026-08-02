import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// GET /api/strategies/versions?market=us|india
// Market-scoped: each market promotes its OWN champion, so listing both markets'
// versions together renders two rows both badged CHAMPION with nothing telling
// them apart. `strategy_versions.market` is NOT NULL DEFAULT 'us', so plain
// equality is a complete filter. Missing/unknown ?market= defaults to "us".
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  try {
    const supabase = createServiceClient();
    const market: "us" | "india" =
      new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
    const { data: versions, error } = await supabase.from("strategy_versions").select(`
      *, experiment_runs (
        id, run_type, win_rate, avg_return_pct, sharpe_ratio, max_drawdown_pct, gate_pass,
        signal_count, alpha_pct, benchmark_return_pct, completed_at, status
      )
    `).eq("market", market).order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const ids = (versions ?? []).map((v: any) => v.validation_experiment_id).filter((id: any) => id != null);
    let validationById: Record<number, any> = {};
    if (ids.length > 0) {
      const { data } = await supabase.from("validation_experiments")
        .select("id, passed, p_improvement, n_effective, fail_reason, created_at").in("id", ids);
      validationById = Object.fromEntries((data ?? []).map((e: any) => [e.id, e]));
    }
    return NextResponse.json({ market, versions: (versions ?? []).map((v: any) => ({
      ...v, validation: v.validation_experiment_id ? validationById[v.validation_experiment_id] ?? null : null,
    })) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const gate = await requireOwner();
    if (gate) return gate;
    const supabase = createServiceClient();
    const body = await req.json();
    const { action, ...fields } = body as { action?: string; [k: string]: unknown };

    if (action === "promote_champion") {
      const { version_id, force_unvalidated } = fields as { version_id: number; force_unvalidated?: boolean };
      if (!Number.isInteger(version_id) || version_id <= 0) {
        return NextResponse.json({ error: "A positive integer version_id is required." }, { status: 400 });
      }
      if (force_unvalidated !== undefined) {
        return NextResponse.json({ error: "force_unvalidated is not permitted; passed validation is mandatory." }, { status: 400 });
      }
      // Validation, per-market serialization, demotion, and promotion happen in
      // one DB transaction. Any failure preserves the previous champion.
      const { data, error } = await supabase.rpc("promote_strategy_champion", { p_version_id: version_id });
      if (error) {
        const notFound = error.code === "P0002";
        const evidenceBlocked = /validation|required|retired|rejected/i.test(error.message ?? "");
        return NextResponse.json({ error: `Promotion blocked: ${error.message}` }, {
          status: notFound ? 404 : evidenceBlocked ? 412 : 500,
        });
      }
      return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
    }

    if (action === "retire" || action === "reject") {
      const { version_id, reason } = fields as { version_id: number; reason?: string };
      if (!Number.isInteger(version_id) || version_id <= 0) {
        return NextResponse.json({ error: "A positive integer version_id is required." }, { status: 400 });
      }
      const update = action === "retire"
        ? { state: "retired", retired_at: new Date().toISOString(), rejection_reason: reason ?? null }
        : { state: "rejected", rejection_reason: reason ?? "Rejected" };
      const { error } = await supabase.from("strategy_versions").update(update).eq("id", version_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    const { data, error } = await supabase.from("strategy_versions").insert({
      version: fields.version ?? "v1.0.0-draft",
      name: fields.name ?? "Unnamed Strategy",
      description: fields.description ?? null,
      universe: fields.universe ?? "us_equity_etf",
      horizon_days_min: fields.horizon_days_min ?? 2,
      horizon_days_max: fields.horizon_days_max ?? 20,
      direction: "long",
      entry_rules: fields.entry_rules ?? null,
      exit_rules: fields.exit_rules ?? null,
      weights_snapshot: fields.weights_snapshot ?? null,
      parent_version_id: fields.parent_version_id ?? null,
      state: "draft",
      notes: fields.notes ?? null,
    }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, version: data });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
