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

    // Phase 2: attach each version's latest validation result (if 061 applied).
    const vIds = (versions ?? []).map((v: any) => v.validation_experiment_id).filter((id: any) => id != null);
    let validationById: Record<number, any> = {};
    if (vIds.length > 0) {
      const { data: exps } = await supabase.from("validation_experiments")
        .select("id, passed, p_improvement, n_effective, fail_reason, created_at").in("id", vIds);
      validationById = Object.fromEntries((exps ?? []).map((e: any) => [e.id, e]));
    }
    const withValidation = (versions ?? []).map((v: any) => ({
      ...v, validation: v.validation_experiment_id ? (validationById[v.validation_experiment_id] ?? null) : null,
    }));

    return NextResponse.json({ versions: withValidation });
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
      const { version_id, force_unvalidated } = fields as { version_id: number; force_unvalidated?: boolean };
      // Phase 4: champions are PER MARKET. Demote only the SAME market's champion —
      // an unscoped demote would knock out the US champion when promoting an India
      // challenger (and vice-versa). Read the challenger's market first.
      const { data: challenger } = await supabase
        .from("strategy_versions").select("market, validation_experiment_id").eq("id", version_id).maybeSingle();
      const mkt = (challenger as any)?.market ?? "us";

      // Phase 2: EVIDENCE GATE (fail-closed). A challenger may only be promoted
      // if it has a PASSED validation_experiments row. Resilient: if the table
      // or column doesn't exist yet (pre-061), this check is skipped entirely —
      // legacy human-approval-only promotion behavior is preserved unchanged.
      const vId = (challenger as any)?.validation_experiment_id;
      let validated = false;
      let gateApplies = false;
      if (vId !== undefined) { // column exists (061 applied)
        gateApplies = true;
        if (vId) {
          const { data: vx } = await supabase.from("validation_experiments").select("passed").eq("id", vId).maybeSingle();
          validated = (vx as any)?.passed === true;
        }
      }
      if (gateApplies && !validated && force_unvalidated !== true) {
        return NextResponse.json({
          error: "Promotion blocked: challenger has no PASSED validation experiment. Run POST /api/validation/run first (or pass force_unvalidated:true — this is journaled as a governance override).",
        }, { status: 412 });
      }
      if (gateApplies && !validated && force_unvalidated === true) {
        await supabase.from("decision_journal").insert({
          entry_type: "governance_override",
          summary: `Champion promoted WITHOUT a passed validation experiment (force_unvalidated) — strategy_versions.id ${version_id}, market ${mkt}`,
          resolved: true,
        });
      }

      let demote = supabase.from("strategy_versions").update({ is_champion: false }).eq("is_champion", true);
      // Scope to the challenger's market when the column exists; fall back unscoped pre-057.
      const demoteRes = await demote.eq("market", mkt);
      if (demoteRes.error) await supabase.from("strategy_versions").update({ is_champion: false }).eq("is_champion", true);
      // Promote new champion
      const { error } = await supabase.from("strategy_versions").update({
        is_champion: true,
        state: "paper_active",
        promoted_at: new Date().toISOString(),
      }).eq("id", version_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, promoted: version_id, market: mkt });
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
