import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(req: NextRequest) {
  try {
    const svc = createServiceClient();
    // Scope fit scores to the selected market. `strategy_classifications` is
    // populated only by the US classifier (no `market` column, no India data),
    // so for India we return the templates with no fit scores and mark them
    // US-only rather than fabricating India numbers off US classifications.
    const market = req.nextUrl.searchParams.get("market") === "india" ? "india" : "us";

    const { data: templates, error: tErr } = await svc
      .from("strategy_templates")
      .select("id, name, description, rules")
      .order("name");

    if (tErr || !templates) {
      return NextResponse.json({ error: "Failed to load strategies" }, { status: 500 });
    }

    // For each strategy, get top 5 symbols by fit_score
    const strategies = await Promise.all(
      templates.map(async (template: { id: string; name: string; description: string | null; rules: Record<string, unknown> }) => {
        // India: no per-market classification data exists. Return the template
        // with no scores, flagged so the UI marks it "US" instead of a bogus score.
        if (market === "india") {
          return {
            id: template.id,
            name: template.name,
            description: template.description ?? "",
            rules: template.rules,
            top_symbols: [],
            us_only: true,
          };
        }

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
