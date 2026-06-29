import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET() {
  try {
    const svc = createServiceClient();

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
        const { data: classifications } = await svc
          .from("strategy_classifications")
          .select("symbol, fit_score")
          .eq("strategy_id", template.id)
          .order("fit_score", { ascending: false })
          .limit(5);

        return {
          id: template.id,
          name: template.name,
          description: template.description ?? "",
          rules: template.rules,
          top_symbols: (classifications ?? []).map((c: { symbol: string; fit_score: number }) => ({
            symbol: c.symbol,
            fit_score: c.fit_score,
          })),
        };
      })
    );

    return NextResponse.json({ strategies });
  } catch (err) {
    console.error("strategies GET error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
