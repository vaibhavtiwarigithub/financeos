import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Period → cutoff date (null = ALL). YTD handled specially.
function periodCutoff(period: string | null): string | null {
  const now = Date.now();
  const day = 86400_000;
  switch ((period ?? "").toLowerCase()) {
    case "1w": return new Date(now - 7 * day).toISOString();
    case "1m": return new Date(now - 30 * day).toISOString();
    case "3m": return new Date(now - 90 * day).toISOString();
    case "1y": return new Date(now - 365 * day).toISOString();
    case "ytd": return new Date(new Date().getFullYear(), 0, 1).toISOString();
    case "all":
    default: return null;
  }
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  // Accept ?symbol=X (single) or ?symbols=X,Y,Z (multi, for the Score Tracker).
  const raw = (p.get("symbols") ?? p.get("symbol") ?? "").toUpperCase();
  const symbols = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (symbols.length === 0) return NextResponse.json({ history: [], bySymbol: {} });

  const cutoff = periodCutoff(p.get("period"));

  try {
    const svc = createServiceClient();
    // Request the explain columns (migration 055). If they don't exist yet the
    // query errors, so fall back to the base column set.
    const FULL = "symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, source, rationale, research_packet_id, used_champion_weights, created_at";
    const BASE = "symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, source, created_at";

    const runQuery = (cols: string) => {
      let q = svc.from("signal_score_history").select(cols).in("symbol", symbols).order("created_at", { ascending: true }).limit(500);
      if (cutoff) q = q.gte("created_at", cutoff);
      return q;
    };

    let { data, error } = await runQuery(FULL);
    if (error) ({ data, error } = await runQuery(BASE));
    if (error) return NextResponse.json({ history: [], bySymbol: {}, error: error.message });

    const rows = data ?? [];
    // Group by symbol for the multi-line chart; keep a flat `history` for the
    // single-symbol callers (symbol detail page) that expect it.
    const bySymbol: Record<string, any[]> = {};
    for (const r of rows as any[]) {
      (bySymbol[r.symbol] ??= []).push(r);
    }
    return NextResponse.json({ history: rows, bySymbol });
  } catch {
    return NextResponse.json({ history: [], bySymbol: {} });
  }
}
