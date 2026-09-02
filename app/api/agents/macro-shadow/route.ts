import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { isEtfSymbol } from "@/lib/asset-classification";
import {
  macroCounterfactual,
  classifyFlip,
  summarize,
  toDimensionRecord,
  type MacroCounterfactualRow,
} from "@/lib/learning/macro-counterfactual";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 of the macro-dimension role correction — MEASURE ONLY.
// features/macro-dimension-role/FEATURE_ARCHITECTURE.md
//
// Replays every recorded decision with `macro` excluded from the weighted score
// and reports what eligibility would have been. Reads the immutable decision
// ledger and returns numbers: it writes nothing, and no score, signal, fill,
// size, exit or broker path reads this endpoint.
//
// This is a RETROSPECTIVE replay, not a forward shadow, because the ledger
// already stores everything needed — `weights_used` (the effective, already
// renormalized weights), `availability_mask`, every dimension score, the
// threshold, and `entry_eligible`. All 5,672 US rows carry all five. Waiting N
// sessions to collect what is already recorded would have delayed the answer
// for nothing.
//
// FIDELITY IS CHECKED, NOT ASSUMED: each row is first re-scored WITH macro
// through the production scorer, and a run that cannot reproduce the stored
// analyst_score reports its mismatch rate rather than publishing a
// counterfactual built on a broken replay.
// ─────────────────────────────────────────────────────────────────────────────

type Market = "us" | "india";

async function loadRows(svc: any, market: Market): Promise<Array<MacroCounterfactualRow & { ts: string; symbol: string }>> {
  // PAGINATED. PostgREST silently caps a response at its 1,000-row server
  // maximum and a larger `.limit()` is ignored, not an error — the exact defect
  // that made every US dimension IC before 2026-08-28 a ~40% sample.
  const PAGE = 1000;
  const out: Array<MacroCounterfactualRow & { ts: string; symbol: string }> = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await svc
      .from("decision_observations")
      .select("id,ts,symbol,discovery_source,weights_used,availability_mask,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,analyst_score,score_threshold,entry_eligible")
      .eq("market", market)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`decision_observations query failed: ${error.message}`);
    const page = (data ?? []) as any[];
    for (const r of page) {
      if (r.analyst_score == null) continue;
      out.push({
        ts: String(r.ts),
        symbol: String(r.symbol),
        weightsUsed: toDimensionRecord<number>(r.weights_used, 0),
        included: toDimensionRecord<boolean>(r.availability_mask, false),
        scores: {
          fundamental: Number(r.fundamental_score ?? 0),
          technical: Number(r.technical_score ?? 0),
          sentiment: Number(r.sentiment_score ?? 0),
          macro: Number(r.macro_score ?? 0),
          insider: Number(r.insider_score ?? 0),
        },
        observedScore: Number(r.analyst_score),
        threshold: Number(r.score_threshold ?? 60),
        observedEligible: r.entry_eligible === true,
        // Mirrors how production decides `isEtf`: the curated symbol list
        // (research-agent.ts:670 `isEtfSymbol(sym)`) plus the metals basket,
        // which is pushed with `isEtf: true` (research-agent.ts:876).
        isEtfLike: isEtfSymbol(String(r.symbol)) || String(r.discovery_source ?? "") === "metals_basket",
      });
    }
    if (page.length < PAGE) break;
  }
  return out;
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const param = new URL(request.url).searchParams.get("market");
  const market: Market = param === "india" ? "india" : "us";

  try {
    const rows = await loadRows(createServiceClient(), market);
    const overall = summarize(rows);

    // Per-session detail: the macro value that day, how many decisions it
    // carried over the line, and how many it held under.
    const byDay = new Map<string, {
      macroScore: number | null; observations: number; observedEligible: number;
      losesEligibility: number; mayGainEligibility: number; deltaSum: number; deltaN: number;
    }>();
    for (const row of rows) {
      const day = row.ts.slice(0, 10);
      const result = macroCounterfactual(row);
      const flip = classifyFlip(row, result);
      const entry = byDay.get(day) ?? {
        macroScore: result.macroWasIncluded ? row.scores.macro : null,
        observations: 0, observedEligible: 0, losesEligibility: 0, mayGainEligibility: 0,
        deltaSum: 0, deltaN: 0,
      };
      entry.observations++;
      if (row.observedEligible) entry.observedEligible++;
      if (flip === "loses_eligibility") entry.losesEligibility++;
      if (flip === "may_gain_eligibility") entry.mayGainEligibility++;
      if (result.macroWasIncluded) { entry.deltaSum += result.delta; entry.deltaN++; }
      byDay.set(day, entry);
    }

    // Mismatch samples. A rate alone cannot say WHY a replay fails, and guessing
    // from a SQL approximation of the cap sent this investigation down the wrong
    // path once already — so the route reports the rows it actually failed on.
    const mismatchSamples = rows
      .map((row) => ({ row, result: macroCounterfactual(row) }))
      .filter(({ result }) => !result.replayMatches)
      .sort((a, b) =>
        Math.abs(b.result.replayScore - b.row.observedScore) -
        Math.abs(a.result.replayScore - a.row.observedScore))
      .slice(0, 15)
      .map(({ row, result }) => ({
        symbol: row.symbol,
        date: row.ts.slice(0, 10),
        observed: row.observedScore,
        replayed: result.replayScore,
        gap: result.replayScore - row.observedScore,
        is_etf_like: row.isEtfLike,
        included: Object.entries(row.included).filter(([, v]) => v).map(([k]) => k).join(","),
      }));

    // Mismatches per date. A replay failure concentrated on a few early dates is
    // a legacy scoring cohort to be excluded and named; one spread evenly is a
    // rule this replay is still missing. The two are not distinguishable from a
    // rate, and they call for opposite responses.
    const mismatchesByDate: Record<string, number> = {};
    for (const row of rows) {
      if (macroCounterfactual(row).replayMatches) continue;
      const day = row.ts.slice(0, 10);
      mismatchesByDate[day] = (mismatchesByDate[day] ?? 0) + 1;
    }

    const sessions = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, e]) => ({
      date,
      macro_score: e.macroScore,
      observations: e.observations,
      observed_eligible: e.observedEligible,
      loses_eligibility: e.losesEligibility,
      may_gain_eligibility: e.mayGainEligibility,
      mean_score_delta: e.deltaN ? e.deltaSum / e.deltaN : null,
    }));

    return NextResponse.json({
      market,
      stage: "stage_1_measure_only",
      feature: "features/macro-dimension-role/FEATURE_ARCHITECTURE.md",
      summary: overall,
      mismatchSamples,
      mismatchesByDate,
      sessions,
      interpretation: {
        loses_eligibility:
          "CERTAIN. These decisions were eligible, so every non-score gate was passing; without macro their score falls below the threshold.",
        may_gain_eligibility:
          "UPPER BOUND, not a count of trades. entry_eligible also requires !earningsRepricing.pending and !breakdownVetoed, neither of which is recorded in the ledger, so some of these would have been blocked anyway.",
        blocked_by_other_gate:
          "Scored at or above the threshold yet was not eligible, so a macro-independent gate blocked it. Excluded from the gain count on purpose.",
        replay_match_rate:
          "Fraction of rows whose stored analyst_score was reproduced exactly by re-scoring with the production scorer. Below ~1.0 the counterfactual is not trustworthy and must not be cited.",
      },
      influence: "None. Measure-only; nothing writes, and no scoring, sizing, exit, order or broker path reads this route.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "macro shadow failed" },
      { status: 500 },
    );
  }
}
