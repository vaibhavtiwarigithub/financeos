import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { evaluateGate } from "@/lib/gates/promotion-gate";

export const dynamic = "force-dynamic";

// Phase 2 promotion: the ONLY writer to strategy_policies.
//
// Deterministic end to end — no LLM anywhere on this path. The LLM's role stops
// at proposing a bounded hypothesis into backtest_experiments; the numbers that
// decide promotion come from edge_ic_history, and the decision comes from
// evaluateGate(). This is why strategy_policies.promoted_by is DB-constrained to
// 'deterministic_gate'.
//
// Failure returns 200 with pass=false + machine-readable reasons. A rejected
// promotion is a normal outcome, not an error.

interface PromoteBody {
  edge_id?: string;
  market?: "us" | "india";
  horizon_days_min?: number;
  horizon_days_max?: number;
  /** Which edge_ic_history horizon supplies the evidence. Defaults to horizon_days_max. */
  evidence_horizon?: number;
  sector?: string | null;
  regime?: "trend" | "mean_revert" | "high_vol" | "low_vol" | null;
  /** backtest_experiments.id — supplies variants_run for the DSR penalty. */
  experiment_id?: string;
  notes?: string;
}

export async function POST(req: NextRequest) {
  try {
    // Cron secret OR an authenticated user may trigger; both land on the same
    // deterministic path, so there is no privileged variant to abuse.
    if (!verifyCronSecret(req)) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: PromoteBody = await req.json().catch(() => ({}));
    const edgeId = body.edge_id;
    const market = body.market === "india" ? "india" : "us";
    const hMin = body.horizon_days_min ?? 5;
    const hMax = body.horizon_days_max ?? 20;
    const sector = body.sector ?? null;
    const regime = body.regime ?? null;

    const evidenceHorizon = body.evidence_horizon ?? hMax;

    if (!edgeId) return NextResponse.json({ error: "edge_id is required" }, { status: 400 });
    if (!Number.isInteger(hMin) || hMin <= 0 || !Number.isInteger(hMax) || hMax < hMin) {
      return NextResponse.json({ error: "horizon_days_min/max must be integers with 0 < min <= max" }, { status: 400 });
    }
    if (!Number.isInteger(evidenceHorizon) || evidenceHorizon < hMin || evidenceHorizon > hMax) {
      return NextResponse.json({ error: "evidence_horizon must be an integer within [horizon_days_min, horizon_days_max]" }, { status: 400 });
    }

    const svc = createServiceClient();

    // Evidence: IC windows for this edge/market/segment inside the horizon band.
    let icQuery = svc
      .from("edge_ic_history")
      .select("window_end, created_at, ic, t_stat, horizon, formula_version, run_fingerprint, segment_type, segment_value")
      .eq("edge_id", edgeId)
      .eq("market", market)
      // ONE horizon per evaluation. A band filter (gte/lte) interleaves 5d/10d/20d
      // rows into a single ics[] ordered only by window_end, so "the latest window"
      // became whichever horizon happened to sort last — the walk-forward and
      // t-stat gates were then comparing different horizons to each other.
      // The band stays as policy metadata; the evidence horizon defaults to hMax.
      .eq("horizon", evidenceHorizon)
      .order("window_end", { ascending: true });

    // Segment scoping: a sector/regime policy must be gated on that segment's IC,
    // not on the all-universe IC.
    //
    // Market-wide is ('market','all'), NOT a null segment_type — edge-ic/route.ts
    // always writes an explicit segment tuple and there is not a single null row
    // in the table. Matching on null here made every market-wide promote return
    // `insufficient_windows:0<3`, i.e. the gate was a silent no-op.
    if (sector) icQuery = icQuery.eq("segment_type", "sector").eq("segment_value", sector);
    else if (regime) icQuery = icQuery.eq("segment_type", "regime").eq("segment_value", regime);
    else icQuery = icQuery.eq("segment_type", "market").eq("segment_value", "all");

    const { data: icRows, error: icError } = await icQuery;
    if (icError) throw new Error(`edge_ic_history read failed: ${icError.message}`);

    type IcRow = {
      window_end: string; created_at: string;
      ic: number | null; t_stat: number | null;
      formula_version: string | null; run_fingerprint: string | null;
    };
    const usable = ((icRows ?? []) as IcRow[]).filter(
      (r) => r.ic !== null && r.t_stat !== null,
    );

    // Dedupe by window_end, newest run wins.
    //
    // edge-ic can write more than one row for the same window_end (re-runs, or a
    // universe that changed size mid-day). Measured in prod 2026-07-27: US edges
    // had 6 rows across only 4 distinct window_end values, from 6 distinct
    // run_fingerprints, with universe_size drifting 31 → 32 → 40. Counting those
    // as 6 windows inflated sample_n and let a re-run of the same day masquerade
    // as fresh evidence.
    const byWindow = new Map<string, IcRow>();
    for (const r of usable) {
      const prev = byWindow.get(r.window_end);
      if (!prev || r.created_at > prev.created_at) byWindow.set(r.window_end, r);
    }
    const rows = [...byWindow.values()].sort((a, b) => a.window_end.localeCompare(b.window_end));
    const duplicateWindowsDropped = usable.length - rows.length;

    // variants_run drives the DSR selection-bias penalty. Absent an experiment we
    // assume 1 trial — the least punitive assumption, so the other gates carry it.
    let trialsRun = 1;
    if (body.experiment_id) {
      const { data: exp, error: expError } = await svc
        .from("backtest_experiments")
        .select("id, variants_run, variants_proposed, variant_budget")
        .eq("id", body.experiment_id)
        .maybeSingle();
      if (expError) throw new Error(`backtest_experiments read failed: ${expError.message}`);
      if (!exp) return NextResponse.json({ error: "experiment_id not found" }, { status: 404 });
      trialsRun = exp.variants_run ?? exp.variants_proposed ?? exp.variant_budget ?? 1;
    }

    const gate = evaluateGate({
      ics: rows.map((r) => Number(r.ic)),
      tStats: rows.map((r) => Number(r.t_stat)),
      trialsRun,
    });

    const segment = { market, sector, regime, horizon_days_min: hMin, horizon_days_max: hMax };

    if (!gate.pass) {
      return NextResponse.json({
        promoted: false,
        edge_id: edgeId,
        segment,
        trials_run: trialsRun,
        gate,
      });
    }

    // model_id identifies exactly which formula build the evidence came from.
    const latest = rows[rows.length - 1];
    const modelId = latest.formula_version ?? latest.run_fingerprint ?? edgeId;

    // Supersede the incumbent BEFORE insert — the partial unique index allows
    // only one non-superseded row per segment.
    const supersedeQuery = svc
      .from("strategy_policies")
      .update({ superseded_at: new Date().toISOString() })
      .eq("market", market)
      .eq("horizon_days_min", hMin)
      .eq("horizon_days_max", hMax)
      .is("superseded_at", null);
    const { data: superseded, error: supersedeError } = await (
      sector ? supersedeQuery.eq("sector", sector) : supersedeQuery.is("sector", null)
    )
      .select("id, model_id");
    if (supersedeError) throw new Error(`supersede failed: ${supersedeError.message}`);

    const { data: policy, error: insertError } = await svc
      .from("strategy_policies")
      .insert({
        market,
        sector,
        regime,
        horizon_days_min: hMin,
        horizon_days_max: hMax,
        model_id: modelId,
        // First policy for a segment is the baseline; anything replacing an
        // incumbent is a variant that beat it.
        verdict: (superseded?.length ?? 0) > 0 ? "variant" : "baseline",
        sample_n: gate.sample_n,
        dsr: gate.dsr_z,
        // Column name predates the 2026-07-27 finding that these windows overlap
        // ~98% and are not walk-forward folds. It stores IC estimate STABILITY.
        // Renaming it needs a migration on an append-only governance table and is
        // deferred until real folds land (features/walk-forward-ic-folds/).
        walk_forward_pass: gate.ic_stability_pass,
        promoted_by: "deterministic_gate",
        notes: body.notes ?? `t_stat_latest=${gate.t_stat_latest?.toFixed(2)}, trials_run=${trialsRun}, edge_id=${edgeId}`,
      })
      .select()
      .single();
    if (insertError) throw new Error(`strategy_policies insert failed: ${insertError.message}`);

    // Close the lineage loop so an experiment points at the policy it produced.
    if (body.experiment_id) {
      await svc
        .from("backtest_experiments")
        .update({ policy_id: policy.id, completed_at: new Date().toISOString() })
        .eq("id", body.experiment_id);
    }

    return NextResponse.json({
      promoted: true,
      edge_id: edgeId,
      segment,
      trials_run: trialsRun,
      gate,
      policy,
      superseded: superseded ?? [],
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
