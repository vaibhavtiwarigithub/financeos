import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { buildMacroForwardEvidence } from "@/lib/learning/macro-forward-evidence";
import { CURRENT_LABEL_CONTRACT_VERSION } from "@/lib/learning/label-contract";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HORIZONS = [2, 5, 10, 20];
const INDIA_SERIES = [
  "nifty50_close", "india_vix", "usdinr_spot", "brent_front",
  "india_10y_yield_fred", "fii_net_cr", "dii_net_cr",
];

/** Owner-only, read-only macro-to-forward-return evidence. No external calls or writes. */
export async function GET(request: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const market = request.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }

  try {
    const svc = createServiceClient();
    const since = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const labels = await fetchAllRows((from, to) => svc.from("observation_labels")
      .select("id,horizon_days,label_contract_version,benchmark_neutral_return,fwd_return,decision_observations!inner(ts,symbol,market,macro_score,analyst_score,availability_mask,technical_as_of:features->technical->>as_of,formula_lineage:features->formula_lineage)")
      .eq("decision_observations.market", market)
      .eq("label_contract_version", CURRENT_LABEL_CONTRACT_VERSION)
      .gte("decision_observations.ts", since)
      .in("horizon_days", HORIZONS)
      .not("fwd_return", "is", null)
      .lte("matured_at", new Date().toISOString())
      .order("id", { ascending: true })
      .range(from, to), `macro ${market} matured labels`);

    let factorRows: any[] = [];
    if (market === "india") {
      factorRows = await fetchAllRows((from, to) => svc.from("india_macro_observations")
        .select("series_id,source,obs_date,value,fetched_at")
        .in("series_id", INDIA_SERIES)
        .gte("obs_date", new Date(Date.now() - 800 * 86_400_000).toISOString().slice(0, 10))
        .order("id", { ascending: true })
        .range(from, to), "India macro as-of factor history");
    }

    const cells = buildMacroForwardEvidence(market, labels as any[], factorRows);
    return NextResponse.json({
      market,
      evaluatedAt: new Date().toISOString(),
      horizonSessions: HORIZONS,
      rowsRead: labels.length,
      cells,
      interpretation: market === "us"
        ? "US macro is one market-wide score. Its family-level association is time-series evidence, not cross-sectional stock-picking IC. A fixed US equity/semiconductor exposure map separately compares raw vs direction-oriented macro scores with absolute returns for SPY/QQQ/SOXX/SOXL/TQQQ/SOXS/SQQQ; this is a shadow diagnostic, not a score or trading rule."
        : "India macro remains excluded from the composite. Factor values are joined only when first-seen fetched_at and observation date are no later than the frozen decision. Same-date symbols are aggregated once per family; this is association, not causation or a forecast.",
      limitations: [
        "Family-level rows require a matured benchmark-neutral label; the fixed US instrument comparison requires a matured absolute return. The two estimands are kept separate.",
        "The fixed US instrument comparison reports per-symbol associations, not cross-sectional IC or validated strategy performance.",
        "Horizon-spaced windows are non-overlapping by date selection, not a claim that macro episodes are independent or an effective sample size.",
        "No inferential t-statistic, validated status, score mutation, LLM call, provider fetch, database write, or trading effect is produced.",
        "Instrument-family results reflect the symbols researched by Kairos, not the full market universe.",
      ],
      influence: "read_only_measurement_only",
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "macro evidence evaluation failed" }, { status: 500 });
  }
}
