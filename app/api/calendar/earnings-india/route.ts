import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchIndiaEarningsDate } from "@/lib/india-data";
import { NIFTY_50 } from "@/lib/india-universe";

// India earnings calendar. There is NO free full-market India earnings feed, so
// this is built per-symbol from the India watchlist (NIFTY-50 stand-in) plus any
// open India paper positions, calling fetchIndiaEarningsDate per name. Sorted by
// date. The UI surfaces a note that this covers tracked symbols only.

export type EarningsEvent = {
  symbol: string;
  name: string;
  reportDate: string;
  timing: "am" | "pm" | "";
  epsEstimate: string;
  epsActual: string | null;
  quarter: string;
};

// Default India universe: top NIFTY-50 names (keep it modest — each is a Yahoo
// round-trip). Accepts ?symbols=RELIANCE.NS,TCS.NS override.
const DEFAULT_INDIA_WATCHLIST = NIFTY_50.slice(0, 15);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get("symbols");

  let symbols = symbolsParam
    ? symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...DEFAULT_INDIA_WATCHLIST];

  // Fold in any open India paper positions so held names always appear.
  try {
    const svc = createServiceClient();
    const { data: pos, error } = await svc.from("paper_positions").select("symbol, market");
    if (!error && pos) {
      const held = pos
        .filter((p: Record<string, unknown>) => {
          const m = (p.market as string | undefined) ?? "us";
          const sym = String(p.symbol ?? "").toUpperCase();
          // market column may not exist on older rows — fall back to symbol suffix.
          return m === "india" || sym.endsWith(".NS") || sym.endsWith(".BO");
        })
        .map((p: Record<string, unknown>) => String(p.symbol).toUpperCase());
      symbols = [...new Set([...symbols, ...held])];
    }
  } catch {
    /* positions optional — watchlist alone is fine */
  }

  // Per-symbol earnings dates (parallel, bounded by watchlist size).
  const events: EarningsEvent[] = [];
  const results = await Promise.all(
    symbols.map(async (sym) => {
      const date = await fetchIndiaEarningsDate(sym);
      return date ? { sym, date } : null;
    })
  );

  for (const r of results) {
    if (!r) continue;
    events.push({
      symbol: r.sym,
      name: r.sym.replace(/\.(NS|BO)$/i, ""),
      reportDate: r.date,
      timing: "",
      epsEstimate: "",
      epsActual: null,
      quarter: "",
    });
  }

  events.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  return NextResponse.json({
    earnings: events,
    source: "india_yahoo",
    note: "India: earnings dates for tracked symbols only (no full-market feed).",
  });
}
