/**
 * Read-only exit-geometry backtest over the full price panel.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/exit-geometry-panel.ts
 *
 * WHY THIS EXISTS. The ATR-stop hypothesis (H1) has been gated on a weekly
 * shadow that reads matured decision labels, which at h20 had 0.7 of the 12
 * effective non-overlapping observations it requires. But exit geometry is a
 * PURE PRICE question: it needs bars, not scores. price_cache holds ~316
 * symbols with OHLC, so the same question can be answered now over tens of
 * thousands of windows instead of waiting weeks for labels to mature.
 *
 * The score-dependent questions (entry selection, the score-exit trigger)
 * genuinely CANNOT be replayed this way: point-in-time fundamentals and
 * sentiment were never captured before 2026-07-06, so reconstructing them from
 * today's restated data would be look-ahead. This script deliberately covers
 * only the price-only half.
 *
 * Honest-measurement rules applied here:
 *  - Entries are sampled NON-OVERLAPPING (one entry per `stride` sessions per
 *    symbol) so forward windows never share days. Overlapping windows are what
 *    inflated every earlier t-statistic in this project.
 *  - simulateExit's pessimistic intra-bar assumption is used as-is.
 *  - US and India are reported separately, never pooled.
 *  - The universe is the CURRENTLY cached symbol set, so delisted names are
 *    absent. That is survivorship bias; it flatters every arm and is stated in
 *    the output rather than corrected away.
 */
import { createClient } from "@supabase/supabase-js";
import { simulateExit, type SimBar, type PathGeometry } from "../lib/trading/exit-path-sim";

type Market = "us" | "india";
const MAX_SESSIONS = 60;   // stand-in for "no time stop"; time-capped exits reported separately
const STRIDE = 63;         // ~3 months between entries per symbol => disjoint windows
const ATR_LOOKBACK = 14;

function marketOf(symbol: string): Market {
  return symbol.endsWith(".NS") || symbol.endsWith(".BO") ? "india" : "us";
}

/** Wilder-style ATR as a fraction of price, from the bars up to and including the entry. */
function atrPctAt(bars: SimBar[], idx: number): number | null {
  if (idx < ATR_LOOKBACK) return null;
  let sum = 0;
  for (let i = idx - ATR_LOOKBACK + 1; i <= idx; i++) {
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    );
    sum += tr;
  }
  const atr = sum / ATR_LOOKBACK;
  const px = bars[idx].close;
  return px > 0 && Number.isFinite(atr) ? atr / px : null;
}

type Arm = { label: string; build: (atrPct: number | null) => PathGeometry | null };

// Predeclared arms. The current mandate inputs are 7% stop / 8% target, but
// this simulator liquidates a target arm in full and therefore does NOT model
// Kairos's partial-target runner. Naming the family up front keeps this from
// becoming a grid search dressed up as a hypothesis.
const ARMS: Arm[] = [
  { label: "full-exit 7%/8% no trail", build: () => ({ stopPct: 0.07, targetPct: 0.08, maxSessions: MAX_SESSIONS }) },
  { label: "full-exit 7%/8% + trail", build: () => ({ stopPct: 0.07, targetPct: 0.08, trailPct: 0.07, maxSessions: MAX_SESSIONS }) },
  { label: "7% stop, no target, trail", build: () => ({ stopPct: 0.07, trailPct: 0.07, maxSessions: MAX_SESSIONS }) },
  { label: "full-exit 7%/16% + trail", build: () => ({ stopPct: 0.07, targetPct: 0.16, trailPct: 0.07, maxSessions: MAX_SESSIONS }) },
  { label: "2.8 ATR stop / 8% target", build: a => a == null ? null : ({ stopPct: Math.min(0.30, 2.8 * a), targetPct: 0.08, maxSessions: MAX_SESSIONS }) },
  { label: "2.8 ATR stop+trail / 8%", build: a => a == null ? null : ({ stopPct: Math.min(0.30, 2.8 * a), targetPct: 0.08, trailPct: Math.min(0.30, 2.8 * a), maxSessions: MAX_SESSIONS }) },
  { label: "2.8 ATR stop+trail, no tgt", build: a => a == null ? null : ({ stopPct: Math.min(0.30, 2.8 * a), trailPct: Math.min(0.30, 2.8 * a), maxSessions: MAX_SESSIONS }) },
];

function stats(xs: number[]) {
  const n = xs.length;
  if (!n) return { n: 0, mean: NaN, t: NaN, median: NaN, worst: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN, median: sorted[Math.floor(n / 2)], worst: sorted[0] };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) throw new Error("Supabase env missing");
  const svc = createClient(url, key, { auth: { persistSession: false } });

  // Paginate: price_cache is ~83k rows and a single select is capped.
  const bySymbol = new Map<string, SimBar[]>();
  let from = 0;
  for (;;) {
    const { data, error } = await svc
      .from("price_cache")
      .select("symbol,date,high,low,close")
      .not("high", "is", null).not("low", "is", null)
      .order("symbol", { ascending: true }).order("date", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`price_cache read failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data as any[]) {
      const h = Number(r.high), l = Number(r.low), c = Number(r.close);
      if (!(h > 0 && l > 0 && c > 0)) continue;
      const arr = bySymbol.get(r.symbol) ?? [];
      arr.push({ date: String(r.date), high: h, low: l, close: c });
      bySymbol.set(r.symbol, arr);
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  const results = new Map<string, Map<string, number[]>>();
  const reasons = new Map<string, Map<string, Record<string, number>>>();
  // Entry-date buckets. Stride removes WITHIN-symbol overlap, but many symbols
  // share an entry date and move together, so treating every entry as an
  // independent draw overstates t. The date-clustered statistic below averages
  // within each entry date first, then tests across dates.
  const byDate = new Map<string, Map<string, Map<string, number[]>>>();
  let entries = 0;

  for (const [symbol, barsRaw] of bySymbol) {
    const bars = barsRaw.slice().sort((a, b) => a.date.localeCompare(b.date));
    const mkt = marketOf(symbol);
    for (let i = ATR_LOOKBACK; i + MAX_SESSIONS < bars.length; i += STRIDE) {
      const atrPct = atrPctAt(bars, i);
      const window = bars.slice(i, i + MAX_SESSIONS + 1);
      let counted = false;
      for (const arm of ARMS) {
        const geo = arm.build(atrPct);
        if (!geo) continue;
        const ex = simulateExit(window, geo);
        if (ex.ret == null) continue;
        if (!results.has(mkt)) { results.set(mkt, new Map()); reasons.set(mkt, new Map()); }
        const am = results.get(mkt)!;
        const rm = reasons.get(mkt)!;
        if (!am.has(arm.label)) { am.set(arm.label, []); rm.set(arm.label, {}); }
        am.get(arm.label)!.push(ex.ret);
        if (!byDate.has(mkt)) byDate.set(mkt, new Map());
        const dm = byDate.get(mkt)!;
        if (!dm.has(arm.label)) dm.set(arm.label, new Map());
        const dd = dm.get(arm.label)!;
        const key = String(ex.entryDate ?? window[0].date);
        if (!dd.has(key)) dd.set(key, []);
        dd.get(key)!.push(ex.ret);
        const rc = rm.get(arm.label)!;
        rc[ex.reason] = (rc[ex.reason] ?? 0) + 1;
        counted = true;
      }
      if (counted) entries++;
    }
  }

  console.log("\nExit-geometry panel backtest");
  console.log(`symbols ${bySymbol.size} | non-overlapping entries ${entries} | stride ${STRIDE} sessions | max hold ${MAX_SESSIONS}`);
  console.log("Universe = currently cached symbols only: SURVIVORSHIP BIASED, and longer-hold arms may be flattered more.\n");
  console.log("Target arms liquidate 100% and are geometry proxies, NOT Kairos's deployed partial-target ladder.\n");

  for (const mkt of ["us", "india"] as Market[]) {
    const am = results.get(mkt);
    if (!am) continue;
    console.log(`--- ${mkt.toUpperCase()} ---`);
    console.log(`${"arm".padEnd(28)} ${"n".padStart(6)} ${"mean%".padStart(8)} ${"med%".padStart(8)} ${"t_naive".padStart(7)} ${"dates".padStart(6)} ${"t_clust".padStart(9)} ${"worst%".padStart(8)}  exit mix`);
    for (const arm of ARMS) {
      const xs = am.get(arm.label);
      if (!xs?.length) continue;
      const s = stats(xs);
      const rc = reasons.get(mkt)!.get(arm.label)!;
      const mix = Object.entries(rc).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${(100 * v / s.n).toFixed(0)}%`).join(" ");
      const dd = byDate.get(mkt)?.get(arm.label);
      const dateMeans = dd ? [...dd.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length) : [];
      const ds = stats(dateMeans);
      console.log(
        `${arm.label.padEnd(28)} ${String(s.n).padStart(6)} ${(100 * s.mean).toFixed(2).padStart(8)} ` +
        `${(100 * s.median).toFixed(2).padStart(8)} ${s.t.toFixed(2).padStart(7)} ` +
        `${String(ds.n).padStart(6)} ${ds.t.toFixed(2).padStart(9)} ${(100 * s.worst).toFixed(1).padStart(8)}  ${mix}`,
      );
    }
    console.log("");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
