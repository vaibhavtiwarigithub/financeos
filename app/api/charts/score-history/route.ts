import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

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

// Score band → [min, max) bounds on analyst_score (null = unbounded).
function scoreBandBounds(band: string | null): { min: number | null; max: number | null } {
  switch ((band ?? "").toLowerCase()) {
    case "high": return { min: 80, max: null };   // ≥80 (high conviction)
    case "mid": return { min: 50, max: 80 };       // 50–79
    case "low": return { min: null, max: 50 };     // <50
    case "all":
    default: return { min: null, max: null };
  }
}

function dateBoundary(raw: string, endOfDay: boolean): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(Date.UTC(year, month - 1, day));
  if (
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== month - 1 ||
    start.getUTCDate() !== day
  ) return null;
  return new Date(start.getTime() + (endOfDay ? 86_400_000 - 1 : 0)).toISOString();
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const p = req.nextUrl.searchParams;
  // Accept ?symbol=X (single) or ?symbols=X,Y,Z (multi, for the Score Tracker).
  const raw = (p.get("symbols") ?? p.get("symbol") ?? "").toUpperCase();
  const symbols = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (symbols.length === 0) return NextResponse.json({ history: [], bySymbol: {} });
  if (symbols.length > 50 || symbols.some(symbol => !/^[A-Z0-9^&.-]{1,24}$/.test(symbol))) {
    return NextResponse.json({ error: "invalid symbol list" }, { status: 400 });
  }

  const cutoff = periodCutoff(p.get("period"));

  // ── Optional additive filters (all default to no-op = fully back-compatible) ──
  // These map 1:1 to real signal_score_history columns; a value of "all"/absent
  // means "don't constrain this column".
  const norm = (v: string | null) => {
    const s = (v ?? "").trim().toLowerCase();
    return s && s !== "all" ? s : null;
  };
  const marketF = norm(p.get("market"));       // us | india
  const directionF = norm(p.get("direction")); // long | short | neutral
  const sourceF = norm(p.get("source"));       // holding | watchlist | screener
  const band = scoreBandBounds(p.get("scoreBand")); // analyst_score bounds
  // Explicit date range (ISO date, e.g. 2026-01-31). Applied on top of period.
  const fromRaw = (p.get("from") ?? "").trim();
  const toRaw = (p.get("to") ?? "").trim();
  const fromISO = fromRaw ? dateBoundary(fromRaw, false) : null;
  const toISO = toRaw ? dateBoundary(toRaw, true) : null;
  if ((fromRaw && !fromISO) || (toRaw && !toISO)) {
    return NextResponse.json({ error: "from/to must be valid YYYY-MM-DD dates" }, { status: 400 });
  }
  if (fromISO && toISO && fromISO > toISO) {
    return NextResponse.json({ error: "from must be on or before to" }, { status: 400 });
  }

  try {
    const svc = createServiceClient();
    // Request the explain columns (migration 055). If they don't exist yet the
    // query errors, so fall back to the base column set.
    const FULL = "symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, source, rationale, research_packet_id, used_champion_weights, market, created_at";
    const BASE = "symbol, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, source, created_at";

    const runQuery = (cols: string) => {
      let q = svc.from("signal_score_history").select(cols).in("symbol", symbols).order("created_at", { ascending: true }).limit(500);
      if (cutoff) q = q.gte("created_at", cutoff);
      if (marketF) q = q.eq("market", marketF);
      if (directionF) q = q.eq("direction", directionF);
      if (sourceF) q = q.eq("source", sourceF);
      if (band.min !== null) q = q.gte("analyst_score", band.min);
      if (band.max !== null) q = q.lt("analyst_score", band.max);
      if (fromISO) q = q.gte("created_at", fromISO);
      if (toISO) q = q.lte("created_at", toISO);
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
