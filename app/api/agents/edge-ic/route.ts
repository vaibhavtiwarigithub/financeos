import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { computeEdgeIC } from "@/lib/edges/ic";
import { liquidUniverse } from "@/lib/edges/universe";
import type { Market } from "@/lib/edges/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// EdgeIC (P1) — computes rolling Information Coefficient per edge × horizon on the
// broad historical candle universe and writes edge_ic_history + an ADVISORY edge
// lifecycle status. MEASURE-ONLY: writes ONLY edge_ic_history + edge_catalog.status.
// Never touches agent_signals, paper fills, sizing, or any live-money path. The
// status is advisory ("shadow_eligible" means it MAY enter shadow later — it does
// NOT grant trade permission). Bounded (maxSymbols/maxDates caps). Idempotent.

const MAX_SYMBOLS_CAP = 200;
const DEFAULT_MAX_SYMBOLS = 40;

async function buildUniverse(svc: any, market: Market, maxSymbols: number, mode: string, offset: number): Promise<string[]> {
  if (mode === "liquid") return liquidUniverse(market).slice(offset, offset + maxSymbols);
  try {
    if (market === "us") {
      const nowIso = new Date().toISOString();
      const { data } = await svc.from("watchlist").select("symbol")
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`).limit(maxSymbols * 3);
      return [...new Set((data ?? []).map((r: any) => String(r.symbol ?? "").toUpperCase().trim()).filter(Boolean))].slice(0, maxSymbols) as string[];
    }
    const { data } = await svc.from("india_screen_cache").select("symbol").not("symbol", "is", null).limit(maxSymbols * 4);
    const seen = new Set<string>(); const syms: string[] = [];
    for (const r of (data ?? []) as any[]) {
      const raw = String(r.symbol ?? "").toUpperCase().trim();
      if (!raw) continue;
      const sym = raw.endsWith(".NS") || raw.endsWith(".BO") ? raw : `${raw}.NS`;
      if (seen.has(sym)) continue; seen.add(sym); syms.push(sym);
      if (syms.length >= maxSymbols) break;
    }
    return syms;
  } catch { return []; }
}

export async function POST(req: NextRequest) {
  const svc = createServiceClient();
  let runId: string | null = null;
  try {
    const isCron = verifyCronSecret(req);
    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const marketParam = url.searchParams.get("market") ?? "both";
    const maxSymbols = Math.max(1, Math.min(MAX_SYMBOLS_CAP, Number(url.searchParams.get("maxSymbols") ?? DEFAULT_MAX_SYMBOLS) || DEFAULT_MAX_SYMBOLS));
    const maxDates = Math.max(5, Math.min(120, Number(url.searchParams.get("maxDates") ?? 60) || 60));
    const stepDays = Math.max(1, Math.min(20, Number(url.searchParams.get("stepDays") ?? 5) || 5));
    const universeMode = url.searchParams.get("universe") === "liquid" ? "liquid" : "watchlist";
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    // Deeper default history for IC so it spans multiple years of forward returns.
    const historyDays = Math.max(120, Math.min(1600, Number(url.searchParams.get("historyDays") ?? 1000) || 1000));
    const markets: Market[] = marketParam === "us" ? ["us"] : marketParam === "india" ? ["india"] : ["us", "india"];

    const { data: runRow } = await svc.from("agent_runs").insert({
      agent_type: "edge_ic", status: "running", trigger_source: isCron ? "scheduled" : "manual",
    } as any).select().single();
    runId = (runRow as any)?.id ?? null;

    const results: Record<string, any> = {};
    for (const market of markets) {
      const symbols = await buildUniverse(svc, market, maxSymbols, universeMode, offset);
      if (!symbols.length) { results[market] = { symbols: 0, icRows: 0 }; continue; }

      const { rows, catalogStatus, report } = await computeEdgeIC({ market, symbols, maxDates, stepDays, candleDays: historyDays });

      let icWritten = 0;
      if (rows.length) {
        const icRows = rows.map(r => ({
          edge_id: r.edgeId, market: r.market, window_end: r.windowEnd, horizon: r.horizon,
          ic: Number.isFinite(r.meanIC) ? r.meanIC : null,
          ic_ir: Number.isFinite(r.icIR) ? r.icIR : null,
          t_stat: Number.isFinite(r.tStat) ? r.tStat : null,
          net_of_fee_ic: null,   // cost/turnover-adjusted alpha is the P5 long-only bucket test
          turnover: null,
          status_after: r.statusAfter,
        }));
        await svc.from("edge_ic_history").upsert(icRows, { onConflict: "edge_id,market,window_end,horizon" });
        icWritten = icRows.length;
      }

      // Advisory catalog status (labels only; nothing reads this to trade).
      for (const [edgeId, status] of Object.entries(catalogStatus)) {
        await svc.from("edge_catalog").update({ status }).eq("edge_id", edgeId);
      }

      results[market] = { symbols: symbols.length, icRows: icWritten, report,
        shadowEligible: Object.entries(catalogStatus).filter(([, s]) => s === "shadow_eligible").map(([e]) => e) };
    }

    if (runId) {
      const total = Object.values(results).reduce((s: number, r: any) => s + (r.icRows ?? 0), 0);
      await svc.from("agent_runs").update({
        status: "done", signals_written: total, completed_at: new Date().toISOString(),
        result_summary: `EdgeIC (measure-only): ${total} edge_ic_history rows across ${markets.join("+")}.`,
      } as any).eq("id", runId);
    }

    return NextResponse.json({
      ok: true, measureOnly: true,
      note: "IC measures whether an edge's ranking predicts forward returns. status='shadow_eligible' is ADVISORY — it does NOT grant trade permission. Priored factors clear at t≈2; net-of-fee long-only alpha is the later P5 gate. Universe is a current-liquid snapshot (survivorship bias) until PIT membership is wired.",
      results,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (runId) { try { await svc.from("agent_runs").update({ status: "error", result_summary: msg.slice(0, 500), completed_at: new Date().toISOString() } as any).eq("id", runId); } catch {} }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ message: "POST to run EdgeIC (owner or cron). Measure-only. Params: market, maxSymbols, maxDates, stepDays." });
}
