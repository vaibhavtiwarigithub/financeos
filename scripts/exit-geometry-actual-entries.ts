/**
 * Frozen, read-only replay of actual clean paper entry EVENTS through the
 * shared paper/live mechanical ladder. No score, order, position or policy write.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/exit-geometry-actual-entries.ts
 */
import { createClient } from "@supabase/supabase-js";
import { simulateExitLadderPath } from "../lib/trading/exit-ladder-sim";
import type { SimBar } from "../lib/trading/exit-path-sim";

type Market = "us" | "india";
type TradeRow = {
  id: string;
  market: Market;
  symbol: string;
  qty: number | string;
  fill_price: number | string;
  executed_at: string;
  paper_event_id: number | string | null;
  signal_id: string | null;
  position_role: string | null;
  tainted: boolean | null;
  excluded_from_learning: boolean | null;
};
type EntryEvent = { key: string; market: Market; symbol: string; date: string; qty: number; fill: number; notional: number };
type Policy = { id: string; targetPct?: number };
type Outcome = { entry: EntryEvent; ret: number; partialTaken: boolean; finalReason: string };

const HORIZONS = [10, 20, 40, 60] as const;
const POLICIES: readonly Policy[] = [
  { id: "partial@8% + runner" , targetPct: 0.08 },
  { id: "partial@16% + runner", targetPct: 0.16 },
  { id: "no target + trail" },
];
const BASELINE = POLICIES[0].id;

function localDate(iso: string, market: Market): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: market === "us" ? "America/New_York" : "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null;
}

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function clusteredT(rows: readonly { date: string; delta: number }[]): { dates: number; t: number | null } {
  const groups = new Map<string, number[]>();
  for (const row of rows) groups.set(row.date, [...(groups.get(row.date) ?? []), row.delta]);
  const dateMeans = [...groups.values()].map((xs) => mean(xs)!).filter(Number.isFinite);
  const avg = mean(dateMeans);
  if (avg == null || dateMeans.length < 2) return { dates: dateMeans.length, t: null };
  const variance = dateMeans.reduce((sum, x) => sum + (x - avg) ** 2, 0) / (dateMeans.length - 1);
  return { dates: dateMeans.length, t: variance > 0 ? avg / Math.sqrt(variance / dateMeans.length) : null };
}

function pct(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, label: string) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) return rows;
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  const svc = createClient(url, key, { auth: { persistSession: false } });

  const [tradeRows, priceRows] = await Promise.all([
    fetchAll<TradeRow>((from, to) => svc.from("paper_trades")
      .select("id,market,symbol,qty,fill_price,executed_at,paper_event_id,signal_id,position_role,tainted,excluded_from_learning")
      .eq("order_side", "buy").order("executed_at").order("id").range(from, to), "paper_trades read failed"),
    fetchAll<any>((from, to) => svc.from("price_cache")
      .select("symbol,date,high,low,close").not("high", "is", null).not("low", "is", null)
      .order("symbol").order("date").range(from, to), "price_cache read failed"),
  ]);

  const grouped = new Map<string, EntryEvent>();
  for (const row of tradeRows) {
    if ((row.market !== "us" && row.market !== "india") || row.tainted === true
        || row.excluded_from_learning === true || (row.position_role ?? "alpha") !== "alpha") continue;
    const qty = Number(row.qty), fill = Number(row.fill_price);
    if (!(qty > 0) || !(fill > 0) || !row.executed_at) continue;
    // Partial exits clone the surviving lot with the same paper_event_id. They
    // are one entry event, not two trades; summing their current lot quantities
    // reconstructs the original filled quantity.
    const key = row.paper_event_id != null ? `${row.market}:event:${row.paper_event_id}`
      : row.signal_id ? `${row.market}:signal:${row.signal_id}` : `${row.market}:row:${row.id}`;
    const prior = grouped.get(key);
    if (prior) {
      if (prior.symbol !== row.symbol || Math.abs(prior.fill - fill) > 1e-8) throw new Error(`inconsistent entry event ${key}`);
      prior.qty += qty;
      prior.notional += qty * fill;
    } else {
      grouped.set(key, {
        key, market: row.market, symbol: row.symbol, date: localDate(row.executed_at, row.market),
        qty, fill, notional: qty * fill,
      });
    }
  }

  const barsBySymbol = new Map<string, SimBar[]>();
  for (const row of priceRows) {
    const high = Number(row.high), low = Number(row.low), close = Number(row.close);
    if (!(high > 0 && low > 0 && close > 0)) continue;
    const bars = barsBySymbol.get(String(row.symbol)) ?? [];
    bars.push({ date: String(row.date), high, low, close });
    barsBySymbol.set(String(row.symbol), bars);
  }

  const entries = [...grouped.values()];
  console.log("\nActual-entry mechanical ladder replay (clean alpha paper entry events)");
  console.log(`events=${entries.length}; partial residual lots are collapsed by paper_event_id`);
  console.log("Target checks use daily close, US stops may use session low, India stops use close-only — matching current monitor evidence.\n");

  for (const market of ["us", "india"] as const) {
    const marketEntries = entries.filter((entry) => entry.market === market);
    console.log(`--- ${market.toUpperCase()} (${marketEntries.length} clean entry events) ---`);
    for (const horizon of HORIZONS) {
      const outcomes = new Map<string, Outcome[]>();
      let missingSymbol = 0, insufficientFuture = 0;
      for (const entry of marketEntries) {
        const future = (barsBySymbol.get(entry.symbol) ?? []).filter((bar) => bar.date > entry.date);
        if (!barsBySymbol.has(entry.symbol)) { missingSymbol += 1; continue; }
        if (future.length < horizon) { insufficientFuture += 1; continue; }
        const path: SimBar[] = [
          { date: entry.date, high: entry.fill, low: entry.fill, close: entry.fill },
          ...future.slice(0, horizon),
        ];
        for (const policy of POLICIES) {
          const result = simulateExitLadderPath(path, {
            market, qty: entry.qty, stopPct: 0.07, targetPct: policy.targetPct,
            maxSessions: horizon, useSessionLow: market === "us",
          });
          if (result.ret == null) continue;
          outcomes.set(policy.id, [...(outcomes.get(policy.id) ?? []), {
            entry, ret: result.ret, partialTaken: result.partialTaken, finalReason: result.finalReason,
          }]);
        }
      }

      const baseline = outcomes.get(BASELINE) ?? [];
      const baselineByKey = new Map(baseline.map((row) => [row.entry.key, row]));
      console.log(`h${horizon}: matched=${baseline.length}, insufficient_future=${insufficientFuture}, missing_symbol=${missingSymbol}`);
      for (const policy of POLICIES) {
        const rows = outcomes.get(policy.id) ?? [];
        const paired = rows.flatMap((row) => {
          const base = baselineByKey.get(row.entry.key);
          return base ? [{ date: row.entry.date, delta: row.ret - base.ret, weight: row.entry.notional }] : [];
        });
        const totalNotional = rows.reduce((sum, row) => sum + row.entry.notional, 0);
        const weightedMean = totalNotional > 0
          ? rows.reduce((sum, row) => sum + row.ret * row.entry.notional, 0) / totalNotional : null;
        const deltaMean = mean(paired.map((row) => row.delta));
        const deltaMedian = median(paired.map((row) => row.delta));
        const deltaWeighted = paired.reduce((sum, row) => sum + row.weight, 0) > 0
          ? paired.reduce((sum, row) => sum + row.delta * row.weight, 0) / paired.reduce((sum, row) => sum + row.weight, 0) : null;
        const clustered = clusteredT(paired);
        const better = paired.length ? paired.filter((row) => row.delta > 0).length / paired.length : null;
        const partials = rows.length ? rows.filter((row) => row.partialTaken).length / rows.length : null;
        console.log(`  ${policy.id.padEnd(24)} mean=${pct(mean(rows.map((row) => row.ret))).padStart(7)} `
          + `notional=${pct(weightedMean).padStart(7)} delta=${pct(deltaMean).padStart(7)} `
          + `delta_notional=${pct(deltaWeighted).padStart(7)} med_delta=${pct(deltaMedian).padStart(7)} `
          + `better=${pct(better).padStart(7)} dates=${clustered.dates} t_delta=${clustered.t?.toFixed(2) ?? "n/a"} partial=${pct(partials)}`);
      }
    }
    console.log("");
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
