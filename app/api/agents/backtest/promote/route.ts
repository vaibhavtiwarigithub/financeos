import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
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
//
// ─── DORMANT — MEASURE-ONLY; THIS ROUTE MUST NOT WRITE A POLICY ─────────────
// The 2026-07-28 permanent-closure conclusion was reversed after adversarial
// review. The measured h5 IC dispersion (~0.27) is real, but it cannot be
// inverted into an "effective breadth" estimate: temporal IC variance combines
// cross-sectional sampling noise, time-varying true IC, changing membership,
// and coverage. The h5 estimate also cannot be transferred to h20.
//
// The measurement is useful negative evidence for mom_12_1 at h5. It is not
// evidence that universe-size or sector-neutral experiments cannot help.
// Promotion remains disabled until the experiment lineage, PIT inputs,
// matched-horizon evidence, dependence/cost adjustment, and atomic RPC contract
// are all promotion-grade. EdgeScout/EdgeIC remain advisory diagnostics.
//
// ─── historical record: the 2026-07-27 review findings that first froze it ───
// Adversarial review 2026-07-27 raised one P0 and three P1 findings that each
// independently disqualify the current evidence and write path:
//
//   P0  Promotion is non-atomic. Supersede-then-insert can leave a segment with
//       NO active policy if the insert fails. Needs one locked DB RPC.
//   P1  The evidence is not out-of-sample. The 1000-day IC windows overlap
//       ~98.4%, AND the universe is a CURRENT-liquid snapshot replayed through
//       past dates — survivorship bias that more weekly runs cannot fix.
//   P1  `gate.dsr_z` is NOT the Bailey/López de Prado Deflated Sharpe Ratio. It
//       is a trial-count-adjusted t margin (t − E[max t]); real DSR needs sample
//       length and return skew/kurtosis, computed on cost-adjusted strategy
//       returns, not on IC. It must not be persisted to a column named `dsr`.
//   P1  Experiment lineage is optional and unbound — any experiment_id can
//       supply a favourable trial count for any edge.
//
// So the route fails closed rather than relying on the accident that today's
// best t-stat (US 1.73 / India 1.04) sits below the 2.0 hurdle. A drifting IC
// must not be able to quietly turn this back on.
//
// Re-enable ONLY after features/walk-forward-ic-folds/FEATURE_ARCHITECTURE.md is
// approved and its build sequence has shipped: frozen experiment lineage → PIT
// universe/inputs → purged market-session OOS folds → aggregate HAC IC →
// multiple-testing + cost-adjusted validation → atomic promotion RPC.
//
// Everything below the guard is retained deliberately: it still returns the gate
// verdict, so the evidence can be inspected without any write being possible.
// False until the evidence contract documented above is complete and approved.
// This is deliberately not an environment toggle: deployment configuration
// must never turn incomplete research evidence into trade authority.
const PROMOTION_ENABLED = false;

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
    // Cron secret OR the confirmed owner may trigger. The deterministic gate
    // prevents discretionary promotion, but request parameters still select the
    // evidence and policy segment, so ordinary authenticated users must not have
    // service-role write authority over this governance ledger.
    if (!verifyCronSecret(req)) {
      const ownerGate = await requireOwner();
      if (ownerGate) return ownerGate;
    }

    const body: PromoteBody = await req.json().catch(() => ({}));
    const edgeId = body.edge_id;
    const market = body.market;
    const hMin = body.horizon_days_min ?? 5;
    const hMax = body.horizon_days_max ?? 20;
    const sector = typeof body.sector === "string" ? body.sector.trim() : null;
    const regime = body.regime ?? null;

    const evidenceHorizon = body.evidence_horizon ?? hMax;

    if (!edgeId) return NextResponse.json({ error: "edge_id is required" }, { status: 400 });
    // Lineage is mandatory, not optional. The current schema binds market and
    // segment and supplies the trial count. It does NOT yet bind edge id,
    // formula version, or evidence horizon, which is one reason promotion must
    // remain dormant until the lineage schema is completed.
    if (!body.experiment_id) {
      return NextResponse.json({
        error: "trial_family_incomplete",
        detail: "experiment_id is required: a promotion must cite the frozen experiment whose variants_run bounds its multiple-testing adjustment.",
      }, { status: 400 });
    }
    if (market !== "us" && market !== "india") {
      return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
    }
    if (body.sector !== undefined && body.sector !== null && !sector) {
      return NextResponse.json({ error: "sector must be a non-empty string or null" }, { status: 400 });
    }
    if (sector && regime) {
      return NextResponse.json({
        error: "sector and regime cannot both be set: edge_ic_history has no combined sector+regime evidence",
      }, { status: 400 });
    }
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

    // variants_run drives the multiple-testing adjustment, so it must be the
    // number of variants ACTUALLY RUN — not proposed, not budgeted. The old
    // fallback chain (variants_run ?? variants_proposed ?? variant_budget ?? 1)
    // silently substituted a smaller, more flattering trial count whenever the
    // engine had not recorded its run count, which is exactly backwards: an
    // unknown trial count must fail closed, not default to the weakest penalty.
    const { data: exp, error: expError } = await svc
      .from("backtest_experiments")
      .select("id, market, segment_type, segment_value, variants_run, policy_id")
      .eq("id", body.experiment_id)
      .maybeSingle();
    if (expError) throw new Error(`backtest_experiments read failed: ${expError.message}`);
    if (!exp) return NextResponse.json({ error: "experiment_id not found" }, { status: 404 });

    const expectedSegmentType = sector ? "sector" : regime ? "regime" : "market";
    const expectedSegmentValue = sector ?? regime ?? "all";
    if (exp.market !== market || exp.segment_type !== expectedSegmentType || exp.segment_value !== expectedSegmentValue) {
      return NextResponse.json({
        error: "experiment_scope_mismatch",
        detail: `experiment covers ${exp.market}/${exp.segment_type}/${exp.segment_value}, request is ${market}/${expectedSegmentType}/${expectedSegmentValue}`,
      }, { status: 400 });
    }
    if (typeof exp.variants_run !== "number" || exp.variants_run < 1) {
      return NextResponse.json({
        error: "trial_family_incomplete",
        detail: "experiment has no recorded variants_run; the multiple-testing adjustment cannot be computed.",
      }, { status: 400 });
    }
    const trialsRun = exp.variants_run;

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

    // Gate says pass — but the evidence class itself is disqualified. Fail closed
    // BEFORE any supersede or insert. See the DORMANT banner at the top of this
    // file. 503 (not 200) because this is a capability that is switched off, not
    // a verdict about this particular edge.
    if (!PROMOTION_ENABLED) {
      return NextResponse.json({
        promoted: false,
        error: "promotion_evidence_not_oos",
        detail:
          "Promotion is dormant. Current edge_ic_history evidence is not out-of-sample " +
          "(~98.4% window overlap, current-universe survivorship), and experiment lineage " +
          "does not yet bind edge/formula/horizon. Re-enable only after " +
          "features/walk-forward-ic-folds ships.",
        edge_id: edgeId,
        segment,
        trials_run: trialsRun,
        gate,
      }, { status: 503 });
    }

    // model_id identifies exactly which formula build the evidence came from.
    const latest = rows[rows.length - 1];
    const modelId = latest.formula_version ?? latest.run_fingerprint ?? edgeId;

    // One locked transaction does validate → supersede → insert → bind.
    //
    // The route no longer issues its own supersede and insert. Those were two
    // separate round trips: if the insert failed after the supersede committed,
    // the segment was left with NO active policy. The partial unique index stops
    // two active rows but cannot stop zero. promote_strategy_policy() takes a
    // per-segment advisory lock, re-validates the experiment binding server-side,
    // and rolls everything back together on any failure. Proven in prod on
    // 2026-07-28 with a forced mid-transaction insert failure: the incumbent
    // survived unchanged.
    //
    // experiment_id is REQUIRED here (the RPC rejects a null) because an unbound
    // experiment could otherwise supply a favourable trial count for any edge.
    const { data: rpcResult, error: rpcError } = await svc.rpc("promote_strategy_policy", {
      p_experiment_id:      body.experiment_id,
      p_market:             market,
      p_sector:             sector,
      p_regime:             regime,
      p_horizon_days_min:   hMin,
      p_horizon_days_max:   hMax,
      p_model_id:           modelId,
      p_validation_mode:    "purged_temporal_oos",
      p_sample_n:           gate.sample_n,
      p_t_margin_vs_trials: gate.t_margin_vs_trials,
      p_ic_stability_pass:  gate.ic_stability_pass,
      p_notes:              body.notes ?? `t_stat_latest=${gate.t_stat_latest?.toFixed(2)}, t_margin_vs_trials=${gate.t_margin_vs_trials?.toFixed(2)}, trials_run=${trialsRun}, edge_id=${edgeId}`,
    });
    // The RPC's refusal codes (market_scope_mismatch, experiment_scope_mismatch,
    // trial_family_incomplete, …) are the contract — surface them verbatim.
    if (rpcError) throw new Error(`promote_strategy_policy failed: ${rpcError.message}`);

    return NextResponse.json({
      promoted: true,
      edge_id: edgeId,
      segment,
      policy_id:  (rpcResult as any)?.policy_id ?? null,
      superseded: (rpcResult as any)?.superseded ?? null,
      verdict:    (rpcResult as any)?.verdict ?? null,
      trials_run: trialsRun,
      gate,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
