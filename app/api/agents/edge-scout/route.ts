import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { EDGES } from "@/lib/edges/registry";
import { computeEdges } from "@/lib/edges/compute";
import type { Market } from "@/lib/edges/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// EdgeScout — deterministic price/volume edge computation. MEASURE-ONLY (P0).
//
// HARD CONTRACT: writes ONLY to edge_* tables. Never touches agent_signals,
// paper_trades, paper_order_events, broker_orders, strategy_config, analyst_score,
// sizing, or any live-money path. No fundamentals. Bounded provider usage (maxSymbols
// cap + cached/budgeted candle fetchers). Idempotent (unique upserts). The P0
// universe is a CURRENT-liquid snapshot recorded in edge_universe_members — it is
// NOT point-in-time index membership, and this limitation is reported honestly.

const MAX_SYMBOLS_CAP = 100;
const DEFAULT_MAX_SYMBOLS = 40;
const MAX_DAYS_CAP = 20;

async function seedCatalog(svc: any) {
  const rows = EDGES.map(e => ({
    edge_id: e.id, name: e.name, category: e.category,
    formula_spec: null, inputs: [], rationale: e.rationale,
    expected_sign: e.expectedSign, horizon_days: e.horizonDays,
    data_source: e.dataSource, reference_urls: e.references, status: "candidate",
  }));
  await svc.from("edge_catalog").upsert(rows, { onConflict: "edge_id" });
}

async function buildUniverse(svc: any, market: Market, maxSymbols: number): Promise<{ symbols: string[]; source: string }> {
  try {
    if (market === "us") {
      const nowIso = new Date().toISOString();
      const { data } = await svc.from("watchlist").select("symbol")
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`).limit(maxSymbols * 3);
      const syms = [...new Set((data ?? []).map((r: any) => String(r.symbol ?? "").toUpperCase().trim()).filter(Boolean))].slice(0, maxSymbols);
      return { symbols: syms as string[], source: "watchlist" };
    }
    const { data } = await svc.from("india_screen_cache").select("symbol").not("symbol", "is", null).limit(maxSymbols * 4);
    const seen = new Set<string>();
    const syms: string[] = [];
    for (const r of (data ?? []) as any[]) {
      const raw = String(r.symbol ?? "").toUpperCase().trim();
      if (!raw) continue;
      const sym = raw.endsWith(".NS") || raw.endsWith(".BO") ? raw : `${raw}.NS`;
      if (seen.has(sym)) continue;
      seen.add(sym); syms.push(sym);
      if (syms.length >= maxSymbols) break;
    }
    return { symbols: syms, source: "india_screen_cache" };
  } catch (e: any) {
    return { symbols: [], source: `error:${e?.message ?? "universe"}` };
  }
}

function weekdaysBetween(from: string, to: string, cap: number): string[] {
  const out: string[] = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  for (let d = start; d <= end && out.length < cap; d = new Date(d.getTime() + 86400_000)) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(d.toISOString().slice(0, 10));
  }
  return out;
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
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const maxDays = Math.max(1, Math.min(MAX_DAYS_CAP, Number(url.searchParams.get("maxDays") ?? 5) || 5));
    const markets: Market[] = marketParam === "us" ? ["us"] : marketParam === "india" ? ["india"] : ["us", "india"];

    const { data: runRow } = await svc.from("agent_runs").insert({
      agent_type: "edge_scout", status: "running",
      trigger_source: isCron ? "scheduled" : "manual",
    } as any).select().single();
    runId = (runRow as any)?.id ?? null;

    await seedCatalog(svc);

    const results: Record<string, any> = {};
    for (const market of markets) {
      const { symbols, source } = await buildUniverse(svc, market, maxSymbols);
      const runDate = new Date().toISOString().slice(0, 10);
      const universeId = `${market}:p0:${runDate}`;

      if (symbols.length) {
        const memberRows = symbols.map(s => ({
          universe_id: universeId, market, symbol: s, as_of_date: runDate,
          source, included_reason: "p0_current_liquid_snapshot (NOT point-in-time membership)",
        }));
        await svc.from("edge_universe_members").upsert(memberRows, { onConflict: "universe_id,market,symbol" });
      }

      const asOfDates = (from && to) ? weekdaysBetween(from, to, maxDays) : undefined;
      const { rows, report } = symbols.length
        ? await computeEdges({ market, symbols, asOfDates, maxDays })
        : { rows: [], report: { market, symbolsRequested: 0, symbolsResolved: 0, unavailable: [], sources: {}, benchmarkSource: "n/a", dates: [], rows: 0 } };

      let signalsWritten = 0, inputsWritten = 0;
      if (rows.length) {
        const sigRows = rows.map(r => ({
          symbol: r.symbol, date: r.date, edge_id: r.edgeId, market: r.market,
          raw_value: r.raw, z_value: r.z, universe_id: universeId,
        }));
        const { data: upserted } = await svc.from("edge_signals")
          .upsert(sigRows, { onConflict: "symbol,date,edge_id,market" })
          .select("id,symbol,date,edge_id,market");
        signalsWritten = upserted?.length ?? 0;

        const srcByKey = new Map(rows.map(r => [`${r.symbol}|${r.date}|${r.edgeId}|${r.market}`, r.source]));
        const inputRows = (upserted ?? []).map((u: any) => {
          const src = srcByKey.get(`${u.symbol}|${u.date}|${u.edge_id}|${u.market}`) ?? "unknown";
          const availableAt = new Date(new Date(u.date + "T00:00:00Z").getTime() + 86400_000).toISOString(); // next session
          return {
            edge_signal_id: u.id, input_name: "adjusted_close_candles", source: src,
            as_of_date: u.date, available_at: availableAt, revised_at: null,
            adjustment_policy: "provider split/div-adjusted close where supported", raw_ref: src,
          };
        });
        if (inputRows.length) {
          await svc.from("edge_signal_inputs").upsert(inputRows, { onConflict: "edge_signal_id,input_name,source,as_of_date" });
          inputsWritten = inputRows.length;
        }
      }

      results[market] = { universeId, universeSize: symbols.length, universeSource: source, signalsWritten, inputsWritten, providerReport: report };
    }

    if (runId) {
      const total = Object.values(results).reduce((s: number, r: any) => s + (r.signalsWritten ?? 0), 0);
      await svc.from("agent_runs").update({
        status: "done", signals_written: total, completed_at: new Date().toISOString(),
        result_summary: `EdgeScout (measure-only): ${total} edge_signals across ${markets.join("+")}.`,
      } as any).eq("id", runId);
    }

    return NextResponse.json({
      ok: true, measureOnly: true,
      universeLimitation: "P0 universe is a CURRENT-liquid snapshot recorded in edge_universe_members — NOT point-in-time index membership. IC/backtests built on it carry survivorship bias until PIT membership is wired (P1+).",
      results,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (runId) {
      try { await svc.from("agent_runs").update({ status: "error", result_summary: msg.slice(0, 500), completed_at: new Date().toISOString() } as any).eq("id", runId); } catch {}
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ message: "POST to run EdgeScout (owner or cron). Measure-only. Params: market=us|india|both, maxSymbols, from, to, maxDays." });
}
