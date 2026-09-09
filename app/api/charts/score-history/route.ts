import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// PostgREST caps any response at 1000 rows, so the symbol list is paged rather
// than asking for one oversized page and silently getting a truncated universe.
const SYMBOL_LIST_PAGE = 1000;
const SYMBOL_LIST_MAX_ROWS = 50000;

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

  const cutoff = periodCutoff(p.get("period"));
  // Optional additive filters (all default to no-op = fully back-compatible).
  // These map 1:1 to real signal_score_history columns; "all"/absent means
  // "don't constrain this column".
  const norm = (v: string | null) => {
    const s = (v ?? "").trim().toLowerCase();
    return s && s !== "all" ? s : null;
  };

  // ?list=symbols — every symbol this market has actually scored, newest first.
  //
  // WHY THIS EXISTS. The Score Tracker built its candidate list from watchlist
  // + live holdings, which is not where scores come from. Measured 2026-09-08:
  // 167 US symbols had score history, only 82 were offered, so 128 researched
  // symbols could not be charted at all — screener names get scored for weeks,
  // their auto-added watchlist row expires, and they vanish from the UI while
  // every point stays in the table. The picker now asks the score table itself.
  if ((p.get("list") ?? "").toLowerCase() === "symbols") {
    const svc = createServiceClient();
    const marketList = norm(p.get("market"));
    const seen = new Set<string>();
    for (let from = 0; from < SYMBOL_LIST_MAX_ROWS; from += SYMBOL_LIST_PAGE) {
      let q = svc.from("signal_score_history").select("symbol")
        .order("created_at", { ascending: false })
        .range(from, from + SYMBOL_LIST_PAGE - 1);
      if (marketList) q = q.eq("market", marketList);
      if (cutoff) q = q.gte("created_at", cutoff);
      const { data, error } = await q;
      // Fail loud rather than returning a silently short list the picker would
      // present as "everything that was researched".
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      for (const row of (data ?? []) as { symbol: string }[]) {
        if (row.symbol) seen.add(String(row.symbol).toUpperCase());
      }
      if (!data || data.length < SYMBOL_LIST_PAGE) break;
    }
    return NextResponse.json({ symbols: [...seen] });
  }

  if (symbols.length === 0) return NextResponse.json({ history: [], bySymbol: {}, decisionHistoryBySymbol: {} });
  if (symbols.length > 50 || symbols.some(symbol => !/^[A-Z0-9^&.-]{1,24}$/.test(symbol))) {
    return NextResponse.json({ error: "invalid symbol list" }, { status: 400 });
  }

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
    // A score-history row does not contain the price used by that decision.
    // Pull the immutable decision ledger separately and return canonical
    // research-session points. The client uses these only in single-symbol mode.
    // This is intentionally market-scoped and never joins a ticker across books.
    const decisionRows: any[] = [];
    const pageSize = 1000;
    for (let from = 0; from < 20_000; from += pageSize) {
      let q = svc.from("decision_observations")
        .select("id,ts,market,symbol,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,price_at_decision,features,score_source,scoring_version")
        .in("symbol", symbols)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (marketF) q = q.eq("market", marketF);
      if (cutoff) q = q.gte("ts", cutoff);
      if (fromISO) q = q.gte("ts", fromISO);
      if (toISO) q = q.lte("ts", toISO);
      const page = await q;
      if (page.error) {
        return NextResponse.json({ history: rows, bySymbol, decisionHistoryBySymbol: {}, priceHistoryError: page.error.message });
      }
      decisionRows.push(...(page.data ?? []));
      if (!page.data || page.data.length < pageSize) break;
    }

    const canonical = new Map<string, any>();
    for (const row of decisionRows) {
      const price = Number(row.price_at_decision);
      if (!Number.isFinite(price) || price <= 0) continue;
      const technical = row.features?.technical;
      const technicalSession = typeof technical?.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(technical.as_of)
        ? technical.as_of
        : null;
      const session = technicalSession ?? String(row.ts).slice(0, 10);
      const key = `${row.market}:${row.symbol}:${session}`;
      // Rows arrive by ascending id, so a retry/research rerun in one session
      // deterministically replaces the earlier point in the read model only.
      canonical.set(key, {
        observation_id: row.id,
        symbol: row.symbol,
        market: row.market,
        session,
        session_source: technicalSession ? "technical_as_of" : "observation_date_fallback",
        created_at: row.ts,
        price_at_decision: price,
        analyst_score: row.analyst_score,
        fundamental_score: row.fundamental_score,
        technical_score: row.technical_score,
        sentiment_score: row.sentiment_score,
        macro_score: row.macro_score,
        insider_score: row.insider_score,
        score_source: row.score_source,
        scoring_version: row.scoring_version,
      });
    }
    const decisionHistoryBySymbol: Record<string, any[]> = {};
    for (const point of canonical.values()) {
      (decisionHistoryBySymbol[point.symbol] ??= []).push(point);
    }
    for (const points of Object.values(decisionHistoryBySymbol)) {
      points.sort((a, b) => String(a.session).localeCompare(String(b.session)) || Number(a.observation_id) - Number(b.observation_id));
    }
    return NextResponse.json({ history: rows, bySymbol, decisionHistoryBySymbol });
  } catch {
    return NextResponse.json({ history: [], bySymbol: {}, decisionHistoryBySymbol: {} });
  }
}
