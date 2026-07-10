import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

// ── India fit-score model ────────────────────────────────────────────────────
// The US path scores fit from `strategy_classifications`, a US-only table fed by
// the Alpha-Vantage classifier (raw per-symbol fundamentals/technicals vs each
// template's `rules` thresholds). India has no such raw-data classifier, but the
// India research/scanner agents DO write dimension scores (fundamental / technical
// / sentiment / macro / insider, 0–100) to `signal_score_history` (market-tagged,
// migration 057) and `agent_signals`. So for India we score fit *directly from
// those dimension scores*: map each template's rule keys to the dimensions it
// emphasises, then measure how well the current India-scored universe aligns with
// that emphasis. Same output shape as the US path — the page renders identically.

// Which dimension scores each template's rule keys lean on. Weights are relative;
// they're normalised per template. A symbol's fit for a template = weighted avg of
// its dimension scores over that template's emphasis.
type Dim = "fundamental" | "technical" | "sentiment" | "macro" | "insider";
const RULE_DIMENSION: Record<string, Partial<Record<Dim, number>>> = {
  // technical / momentum rules
  rsi_min: { technical: 1 },
  rsi_max: { technical: 1 },
  above_ma50: { technical: 1 },
  above_ma200: { technical: 1 },
  ma50_above_ma200: { technical: 1 },
  bb_lower: { technical: 1 },
  near_52w_high: { technical: 1 },
  pct_from_52w_high_max: { technical: 1 },
  pct_below_52w_high_min: { technical: 1 },
  // fundamental / valuation / quality rules
  peg_max: { fundamental: 1 },
  pe_vs_sector: { fundamental: 1 },
  fcf_yield_min: { fundamental: 1 },
  roe_min: { fundamental: 1 },
  de_max: { fundamental: 1 },
  margin_stable: { fundamental: 1 },
  earnings_consistency: { fundamental: 1 },
  rev_growth_min: { fundamental: 0.6, sentiment: 0.4 },
  revenue_accel: { fundamental: 0.6, sentiment: 0.4 },
  eps_qoq_growth: { fundamental: 1 },
  // sentiment / flow rules
  earnings_revision: { sentiment: 1 },
  insider_buying: { insider: 1 },
  institutional_increase: { insider: 0.5, sentiment: 0.5 },
};

// Derive each template's normalised dimension emphasis from its `rules` keys.
function templateEmphasis(rules: Record<string, unknown>): Record<Dim, number> {
  const acc: Record<Dim, number> = { fundamental: 0, technical: 0, sentiment: 0, macro: 0, insider: 0 };
  for (const key of Object.keys(rules ?? {})) {
    const dims = RULE_DIMENSION[key];
    if (!dims) continue;
    for (const [d, w] of Object.entries(dims)) acc[d as Dim] += w as number;
  }
  const total = (Object.values(acc) as number[]).reduce((s, v) => s + v, 0);
  // No mapped rules → leave zeroed; symbolFit falls back to analyst_score.
  if (total === 0) return acc;
  (Object.keys(acc) as Dim[]).forEach((d) => (acc[d] = acc[d] / total));
  return acc;
}

interface DimRow {
  symbol: string;
  analyst_score: number | null;
  fundamental_score: number | null;
  technical_score: number | null;
  sentiment_score: number | null;
  macro_score: number | null;
  insider_score: number | null;
}

// Fit of one symbol's dimension scores against a template's emphasis (0–100).
function symbolFit(row: DimRow, emphasis: Record<Dim, number>): number {
  const total = (Object.values(emphasis) as number[]).reduce((s, v) => s + v, 0);
  if (total === 0) return Math.round(row.analyst_score ?? 0); // unmapped template → overall quality
  const val: Record<Dim, number | null> = {
    fundamental: row.fundamental_score,
    technical: row.technical_score,
    sentiment: row.sentiment_score,
    macro: row.macro_score,
    insider: row.insider_score,
  };
  let score = 0;
  let usedWeight = 0;
  for (const d of Object.keys(emphasis) as Dim[]) {
    if (emphasis[d] > 0 && val[d] != null) {
      score += emphasis[d] * (val[d] as number);
      usedWeight += emphasis[d];
    }
  }
  // If none of the emphasised dimensions have data, fall back to analyst_score.
  if (usedWeight === 0) return Math.round(row.analyst_score ?? 0);
  return Math.round(score / usedWeight);
}

// Pull the latest India dimension-score row per symbol. Prefers
// `signal_score_history` (all dimensions inline + market column); resilient to
// the `market` column not existing yet (falls back to unscoped), and to the
// whole table not existing (falls back to agent_signals + research_packets join).
async function loadIndiaDimRows(
  svc: ReturnType<typeof createServiceClient>
): Promise<DimRow[]> {
  const COLS =
    "symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, created_at";

  let rows: DimRow[] | null = null;

  // 1) signal_score_history, market-scoped (resilient to missing `market` column).
  const scoped = await svc
    .from("signal_score_history")
    .select(COLS)
    .eq("market", "india")
    .order("created_at", { ascending: false })
    .limit(500);
  if (!scoped.error && scoped.data) {
    rows = scoped.data as unknown as DimRow[];
  } else {
    const unscoped = await svc
      .from("signal_score_history")
      .select(COLS)
      .order("created_at", { ascending: false })
      .limit(500);
    if (!unscoped.error && unscoped.data) rows = unscoped.data as unknown as DimRow[];
  }

  // 2) Fallback: agent_signals joined to research_packets (dimension scores live
  //    on the packet). Market-scoped with asset_class fallback.
  if (!rows || rows.length === 0) {
    const packetCols =
      "symbol, analyst_score, created_at, research_packets(fundamental_score, technical_score, sentiment_score, macro_score, insider_score)";
    const byMarket = await svc
      .from("agent_signals")
      .select(packetCols)
      .eq("market", "india")
      .order("created_at", { ascending: false })
      .limit(500);
    let src = !byMarket.error && byMarket.data ? byMarket.data : null;
    if (!src) {
      const byAsset = await svc
        .from("agent_signals")
        .select(packetCols)
        .eq("asset_class", "india")
        .order("created_at", { ascending: false })
        .limit(500);
      if (!byAsset.error && byAsset.data) src = byAsset.data;
    }
    if (src) {
      rows = (src as unknown as Array<Record<string, unknown>>).map((r) => {
        const pkt = (r.research_packets ?? {}) as Record<string, number | null>;
        return {
          symbol: r.symbol as string,
          analyst_score: (r.analyst_score as number | null) ?? null,
          fundamental_score: pkt.fundamental_score ?? null,
          technical_score: pkt.technical_score ?? null,
          sentiment_score: pkt.sentiment_score ?? null,
          macro_score: pkt.macro_score ?? null,
          insider_score: pkt.insider_score ?? null,
        } as DimRow;
      });
    }
  }

  if (!rows) return [];
  // Keep only the latest row per symbol (rows are ordered newest-first).
  const seen = new Set<string>();
  const latest: DimRow[] = [];
  for (const r of rows) {
    if (!r.symbol || seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    latest.push(r);
  }
  return latest;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  try {
    const svc = createServiceClient();
    // Scope fit scores to the selected market. The US path reads
    // `strategy_classifications` (US-only classifier). India has no such table,
    // so we compute fit directly from India dimension scores instead.
    const market = req.nextUrl.searchParams.get("market") === "india" ? "india" : "us";

    const { data: templates, error: tErr } = await svc
      .from("strategy_templates")
      .select("id, name, description, rules")
      .order("name");

    if (tErr || !templates) {
      return NextResponse.json({ error: "Failed to load strategies" }, { status: 500 });
    }

    // ── India path: score fit directly from India dimension scores ────────────
    if (market === "india") {
      const dimRows = await loadIndiaDimRows(svc);

      // Fresh install / India just enabled: no signals yet. Return the templates
      // in a "no India signals yet — run research" state (NOT "US only").
      if (dimRows.length === 0) {
        const strategies = templates.map(
          (t: { id: string; name: string; description: string | null; rules: Record<string, unknown> }) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? "",
            rules: t.rules,
            top_symbols: [] as Array<{ symbol: string; fit_score: number }>,
            us_only: false,
            no_india_signals: true,
          })
        );
        return NextResponse.json({ market, strategies });
      }

      const strategies = templates.map(
        (template: { id: string; name: string; description: string | null; rules: Record<string, unknown> }) => {
          const emphasis = templateEmphasis(template.rules ?? {});
          const scored = dimRows
            .map((r) => ({ symbol: r.symbol, fit_score: symbolFit(r, emphasis) }))
            .filter((s) => s.fit_score > 0) // 0 = no usable dimension data → not a real match
            .sort((a, b) => b.fit_score - a.fit_score);

          return {
            id: template.id,
            name: template.name,
            description: template.description ?? "",
            rules: template.rules,
            top_symbols: scored.slice(0, 5),
            us_only: false,
          };
        }
      );

      return NextResponse.json({ market, strategies });
    }

    // ── US path (unchanged) — top 5 symbols by fit_score per strategy ─────────
    const strategies = await Promise.all(
      templates.map(async (template: { id: string; name: string; description: string | null; rules: Record<string, unknown> }) => {
        const { data: classifications } = await svc
          .from("strategy_classifications")
          .select("symbol, fit_score")
          .eq("strategy_id", template.id)
          .order("fit_score", { ascending: false })
          .limit(5);

        // A fit_score of 0 almost always means the classifier's data fetch failed for
        // that symbol (see classify/route.ts fallback), not a genuine "0% match" — showing
        // it as a real top match reads as broken output. Treat 0-score rows as no signal.
        const meaningful = (classifications ?? []).filter(
          (c: { symbol: string; fit_score: number }) => (c.fit_score ?? 0) > 0
        );

        return {
          id: template.id,
          name: template.name,
          description: template.description ?? "",
          rules: template.rules,
          top_symbols: meaningful.map((c: { symbol: string; fit_score: number }) => ({
            symbol: c.symbol,
            fit_score: c.fit_score,
          })),
          us_only: false,
        };
      })
    );

    return NextResponse.json({ market, strategies });
  } catch (err) {
    console.error("strategies GET error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
