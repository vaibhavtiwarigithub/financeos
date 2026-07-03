import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// GET: list strategy versions with latest experiment run
export async function GET() {
  try {
    const supabase = createServiceClient();

    const { data: versions, error } = await supabase
      .from("strategy_versions")
      .select(`
        *,
        experiment_runs (
          id, run_type, win_rate, avg_return_pct, sharpe_ratio, gate_pass,
          signal_count, alpha_pct, benchmark_return_pct, completed_at, status
        )
      `)
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ versions: versions ?? [] });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// POST: create a new strategy version (challenger from LearnerAgent or manual)
export async function POST(req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = createServiceClient();
    const body = await req.json();
    const { action, ...fields } = body as { action?: string; [k: string]: unknown };

    // action: "promote_champion", "retire", "reject", or default = create new
    if (action === "promote_champion") {
      const { version_id } = fields as { version_id: number };
      // Demote current champion
      await supabase.from("strategy_versions").update({ is_champion: false }).eq("is_champion", true);
      // Promote new champion
      const { error } = await supabase.from("strategy_versions").update({
        is_champion: true,
        state: "paper_active",
        promoted_at: new Date().toISOString(),
      }).eq("id", version_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, promoted: version_id });
    }

    if (action === "retire") {
      const { version_id, reason } = fields as { version_id: number; reason?: string };
      const { error } = await supabase.from("strategy_versions").update({
        state: "retired",
        retired_at: new Date().toISOString(),
        rejection_reason: reason ?? null,
      }).eq("id", version_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    if (action === "reject") {
      const { version_id, reason } = fields as { version_id: number; reason?: string };
      const { error } = await supabase.from("strategy_versions").update({
        state: "rejected",
        rejection_reason: reason ?? "Rejected",
      }).eq("id", version_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    // Create new version
    const { data, error } = await supabase
      .from("strategy_versions")
      .insert({
        version:    fields.version ?? "v1.0.0-draft",
        name:       fields.name    ?? "Unnamed Strategy",
        description: fields.description ?? null,
        universe:    fields.universe    ?? "us_equity_etf",
        horizon_days_min: fields.horizon_days_min ?? 2,
        horizon_days_max: fields.horizon_days_max ?? 20,
        direction:   "long",
        entry_rules: fields.entry_rules ?? null,
        exit_rules:  fields.exit_rules  ?? null,
        weights_snapshot: fields.weights_snapshot ?? null,
        parent_version_id: fields.parent_version_id ?? null,
        state:       "draft",
        notes:       fields.notes ?? null,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, version: data });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
