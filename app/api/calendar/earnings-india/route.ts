import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchIndiaEarningsDate } from "@/lib/india-data";
import { fetchNseEarnings } from "@/lib/nse-data";
import { NIFTY_50 } from "@/lib/india-universe";

// India earnings calendar. Preferred path is NSE's market-wide results calendar
// (fetchNseEarnings) — a real full-market feed. NSE geo-throttles some IPs and
// fails soft to [], in which case we fall back to a per-symbol Yahoo build over
// the India watchlist (NIFTY-50 stand-in) plus any open India paper positions.
// Both paths are sorted by date; the response note reflects which path ran.

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

// NSE gives dates as DD-MMM-YYYY (e.g. "15-Jul-2026"). Normalize to YYYY-MM-DD so
// India rows display and sort consistently with the US earnings rows (ISO dates).
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function normalizeNseDate(raw: string | null): string {
  if (!raw) return "";
  const s = raw.trim();
  // Already ISO? keep it.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${day}`;
  }
  // Last resort: let Date try, else return raw so it's at least visible.
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get("symbols");

  // Preferred: NSE full-market results calendar. Fails soft → [] (geo-blocked).
  try {
    const nse = await fetchNseEarnings();
    if (nse.length > 0) {
      const events: EarningsEvent[] = nse
        .map((e) => ({
          symbol: e.symbol,
          name: e.company || e.symbol.replace(/\.(NS|BO)$/i, ""),
          reportDate: normalizeNseDate(e.date),
          timing: "" as const,
          epsEstimate: "",
          epsActual: null,
          quarter: "",
        }))
        .filter((e) => e.reportDate);
      events.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
      return NextResponse.json({
        earnings: events,
        source: "nse_calendar",
        note: "India: full NSE results calendar (market-wide).",
      });
    }
  } catch {
    /* NSE optional — fall through to per-symbol Yahoo path */
  }

  // Fallback: per-symbol Yahoo dates over the watchlist + open India positions.
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
    source: "yahoo_per_symbol",
    note: "India: tracked symbols only — NSE calendar unavailable.",
  });
}
