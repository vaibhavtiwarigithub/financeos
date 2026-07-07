import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AV = process.env.ALPHA_VANTAGE_API_KEY ?? "";

// Fetch Alpha Vantage economic function, return latest datapoint
async function avFetch(fn: string, params = "") {
  const url = `https://www.alphavantage.co/query?function=${fn}&apikey=${AV}${params}`;
  const res = await fetch(url, { next: { revalidate: 86400 } });
  return res.json();
}

interface Indicator {
  name: string;
  value: number | null;
  signal: "green" | "yellow" | "orange" | "red";
  description: string;
  weight: number; // 1=low, 2=medium, 3=high
}

async function fetchIndicators(): Promise<Indicator[]> {
  const indicators: Indicator[] = [];

  // 1. Treasury Yield Curve: 2Y vs 10Y
  try {
    const [y2, y10] = await Promise.all([
      avFetch("TREASURY_YIELD", "&interval=monthly&maturity=2year"),
      avFetch("TREASURY_YIELD", "&interval=monthly&maturity=10year"),
    ]);
    // Skip if rate-limited (Note/Information key present) or data missing
    if (y2?.Note || y2?.Information || y10?.Note || y10?.Information) throw new Error("rate_limited");
    const raw2 = y2?.data?.[0]?.value;
    const raw10 = y10?.data?.[0]?.value;
    if (!raw2 || !raw10) throw new Error("no_data");
    const rate2 = parseFloat(raw2);
    const rate10 = parseFloat(raw10);
    if (!rate2 || !rate10 || isNaN(rate2) || isNaN(rate10)) throw new Error("bad_values");
    const spread = rate10 - rate2;
    let signal: "green" | "yellow" | "orange" | "red" = "green";
    if (spread < -0.5) signal = "red";
    else if (spread < 0) signal = "orange";
    else if (spread < 0.5) signal = "yellow";
    indicators.push({
      name: "Yield Curve (10Y-2Y)",
      value: parseFloat(spread.toFixed(3)),
      signal,
      description: spread < 0
        ? `Inverted ${spread.toFixed(2)}% — historically predicts recession 12-18 months out`
        : `Normal slope ${spread.toFixed(2)}% — no inversion signal`,
      weight: 3,
    });
  } catch {}

  // 2. Unemployment (Sahm Rule approximation)
  try {
    const data = await avFetch("UNEMPLOYMENT");
    const readings = (data?.data ?? []).slice(0, 13).map((d: { value: string }) => parseFloat(d.value));
    if (readings.length >= 4) {
      const recent3avg = (readings[0] + readings[1] + readings[2]) / 3;
      const min12 = Math.min(...readings.slice(0, 12));
      const sahm = recent3avg - min12;
      let signal: "green" | "yellow" | "orange" | "red" = "green";
      if (sahm >= 0.5) signal = "red";
      else if (sahm >= 0.3) signal = "orange";
      else if (sahm >= 0.15) signal = "yellow";
      indicators.push({
        name: "Sahm Rule",
        value: parseFloat(sahm.toFixed(3)),
        signal,
        description: `3-month avg unemployment minus 12-month low = ${sahm.toFixed(3)}. Threshold: 0.5% = recession.`,
        weight: 3,
      });
    }
  } catch {}

  // 3. Nonfarm Payrolls (trend)
  try {
    const data = await avFetch("NONFARM_PAYROLL");
    const vals = (data?.data ?? []).slice(0, 4).map((d: { value: string }) => parseFloat(d.value));
    if (vals.length >= 1) {
      const trend3 = vals.slice(0, 3).filter((v: number) => v < 100).length; // <100k jobs = weak
      const latest = vals[0];
      let signal: "green" | "yellow" | "orange" | "red" = "green";
      if (trend3 >= 3) signal = "red";
      else if (trend3 >= 2) signal = "orange";
      else if (trend3 >= 1 || latest < 100) signal = "yellow";
      indicators.push({
        name: "Nonfarm Payrolls",
        value: latest,
        signal,
        description: `Latest: ${latest.toFixed(0)}K jobs. Weak months (<100K) in last 3: ${trend3}/3.`,
        weight: 2,
      });
    }
  } catch {}

  // 4. Real GDP growth
  try {
    const data = await avFetch("REAL_GDP", "&interval=quarterly");
    const vals = (data?.data ?? []).slice(0, 3).map((d: { value: string }) => parseFloat(d.value));
    if (vals.length >= 2) {
      const latest = vals[0];
      const prior = vals[1];
      const growthPct = ((latest - prior) / prior) * 100;
      let signal: "green" | "yellow" | "orange" | "red" = "green";
      if (growthPct < 0) signal = "red";
      else if (growthPct < 1) signal = "orange";
      else if (growthPct < 2) signal = "yellow";
      indicators.push({
        name: "Real GDP Growth",
        value: parseFloat(growthPct.toFixed(2)),
        signal,
        description: `QoQ growth: ${growthPct.toFixed(2)}%. Two negative quarters = technical recession.`,
        weight: 2,
      });
    }
  } catch {}

  // 5. CPI Inflation trend
  try {
    const data = await avFetch("CPI", "&interval=monthly");
    const vals = (data?.data ?? []).slice(0, 3).map((d: { value: string }) => parseFloat(d.value));
    if (vals.length >= 2) {
      const yoyPct = ((vals[0] - vals[1]) / vals[1]) * 100;
      let signal: "green" | "yellow" | "orange" | "red" = "green";
      // High inflation + slowing growth = stagflation = bad
      if (yoyPct > 5) signal = "orange";
      else if (yoyPct > 3.5) signal = "yellow";
      indicators.push({
        name: "CPI Inflation",
        value: parseFloat(yoyPct.toFixed(2)),
        signal,
        description: `MoM annualized: ${yoyPct.toFixed(2)}%. High inflation + weak growth = stagflation risk.`,
        weight: 1,
      });
    }
  } catch {}

  // 6. Retail Sales
  try {
    const data = await avFetch("RETAIL_SALES");
    const vals = (data?.data ?? []).slice(0, 4).map((d: { value: string }) => parseFloat(d.value));
    if (vals.length >= 2) {
      const mom = ((vals[0] - vals[1]) / vals[1]) * 100;
      const declines = vals.slice(0, 3).filter((v: number, i: number, a: number[]) => i > 0 && v < a[i - 1]).length;
      let signal: "green" | "yellow" | "orange" | "red" = "green";
      if (mom < -1 || declines >= 2) signal = "orange";
      else if (mom < 0 || declines >= 1) signal = "yellow";
      indicators.push({
        name: "Retail Sales",
        value: parseFloat(mom.toFixed(2)),
        signal,
        description: `MoM change: ${mom.toFixed(2)}%. Consumer spending is 70% of GDP.`,
        weight: 2,
      });
    }
  } catch {}

  // 7. Federal Funds Rate (pace of tightening)
  try {
    const data = await avFetch("FEDERAL_FUNDS_RATE", "&interval=monthly");
    const vals = (data?.data ?? []).slice(0, 6).map((d: { value: string }) => parseFloat(d.value));
    if (vals.length >= 1) {
      const latest = vals[0];
      const sixMoAgo = vals[5] ?? vals[vals.length - 1];
      const rising = latest > sixMoAgo;
      // High rate + rising = more restrictive
      let signal: "green" | "yellow" | "orange" | "red" = "green";
      if (latest > 5 && rising) signal = "orange";
      else if (latest > 4.5) signal = "yellow";
      else if (latest > 5) signal = "yellow";
      indicators.push({
        name: "Federal Funds Rate",
        value: latest,
        signal,
        description: `Current: ${latest.toFixed(2)}%. ${rising ? "Rising (tightening)" : "Falling/flat (easing)"}. High rates pressure growth.`,
        weight: 2,
      });
    }
  } catch {}

  // 8. Durable Goods Orders (manufacturing proxy)
  try {
    const data = await avFetch("DURABLES");
    const vals = (data?.data ?? []).slice(0, 3).map((d: { value: string }) => parseFloat(d.value));
    if (vals.length >= 2) {
      const mom = ((vals[0] - vals[1]) / vals[1]) * 100;
      let signal: "green" | "yellow" | "orange" | "red" = "green";
      if (mom < -3) signal = "orange";
      else if (mom < 0) signal = "yellow";
      indicators.push({
        name: "Durable Goods Orders",
        value: parseFloat(mom.toFixed(2)),
        signal,
        description: `MoM change: ${mom.toFixed(2)}%. Factory orders signal business investment confidence.`,
        weight: 1,
      });
    }
  } catch {}

  return indicators;
}

function computeRegime(indicators: Indicator[]): {
  danger_score: number | null;
  regime: "green" | "yellow" | "orange" | "red" | "unknown";
  signals_triggered: number;
  indicators_available: number;
} {
  const SIGNAL_WEIGHTS: Record<string, number> = { green: 0, yellow: 1, orange: 2, red: 3 };
  let weightedScore = 0;
  let totalWeight = 0;
  let signals_triggered = 0;

  for (const ind of indicators) {
    const sw = SIGNAL_WEIGHTS[ind.signal] ?? 0;
    weightedScore += sw * ind.weight;
    totalWeight += 3 * ind.weight; // max per indicator
    if (ind.signal !== "green") signals_triggered++;
  }

  // Need at least 3 indicators to compute a meaningful regime. Fewer than
  // that (including zero) is NOT evidence of a healthy economy — it means
  // we don't have enough real data to say anything. Report an explicit
  // "unknown" regime with a null danger score instead of defaulting to a
  // favorable GREEN/0 verdict.
  if (indicators.length < 3) {
    return {
      danger_score: null,
      regime: "unknown" as const,
      signals_triggered: 0,
      indicators_available: indicators.length,
    };
  }

  const danger_score = totalWeight > 0 ? Math.round((weightedScore / totalWeight) * 100) : 0;

  let regime: "green" | "yellow" | "orange" | "red" = "green";
  if (danger_score >= 60) regime = "red";
  else if (danger_score >= 40) regime = "orange";
  else if (danger_score >= 20) regime = "yellow";

  // Override: if both HIGH signals fire red/orange, escalate
  const highSignals = indicators.filter(
    (i) => i.weight === 3 && (i.signal === "red" || i.signal === "orange")
  );
  if (highSignals.length >= 2 && regime === "yellow") regime = "orange";

  return { danger_score, regime, signals_triggered, indicators_available: indicators.length };
}

export async function GET() {
  return NextResponse.json({ message: "Use POST to run MacroSentinel" });
}

export async function POST(req: NextRequest) {
  // Was completely unauthenticated and burns Alpha Vantage budget (already
  // scarce — 25/day). Require cron secret or a logged-in user.
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const weekOf = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD

  // Check if already ran this week with sufficient data
  const { data: existing } = await svc
    .from("macro_regime")
    .select("id, signals_triggered")
    .eq("week_of", weekOf)
    .single();
  // Skip only if we have a good run (3+ indicators fetched)
  if (existing && existing.signals_triggered > 0) {
    return NextResponse.json({ message: "Already ran this week", cached: true });
  }
  // Delete bad/incomplete run so we can retry
  if (existing) {
    await svc.from("macro_regime").delete().eq("week_of", weekOf);
    await svc.from("macro_signals").delete().eq("week_of", weekOf);
  }

  const indicators = await fetchIndicators();
  const { danger_score, regime, signals_triggered, indicators_available } = computeRegime(indicators);

  // Build summary
  const topSignals = indicators
    .filter((i) => i.signal !== "green")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((i) => `${i.name}: ${i.signal.toUpperCase()}`)
    .join("; ");

  // A 0-signal read is only meaningful if we actually collected enough real
  // indicator data. If fewer than 3 of the 8 indicators came back (e.g. Alpha
  // Vantage rate-limited every call), we have no evidence either way — say so
  // explicitly instead of defaulting to a favorable "economy in expansion".
  const summary =
    indicators_available < 3
      ? `Insufficient data: only ${indicators_available}/8 indicators available this run (data source likely rate-limited). No verdict — try "Run Now" again shortly.`
      : signals_triggered === 0
      ? `No recession signals across ${indicators_available}/8 indicators. Economy in expansion.`
      : `${signals_triggered} signal(s) triggered (${indicators_available}/8 indicators available). Top: ${topSignals}`;

  // regime is a free-text column, so "unknown" is safe to store without a migration.
  const { error: regimeError } = await svc.from("macro_regime").upsert(
    {
      week_of: weekOf,
      danger_score: danger_score ?? 0,
      regime,
      signals_triggered,
      ai_bubble_score: 0,
      summary,
      raw_indicators: indicators,
    },
    { onConflict: "week_of" }
  );
  if (regimeError) {
    return NextResponse.json(
      { error: regimeError.message, code: regimeError.code, details: regimeError.details },
      { status: 500 }
    );
  }

  // Insert individual signal rows
  if (indicators.length) {
    const rows = indicators.map((ind) => ({
      week_of: weekOf,
      indicator: ind.name,
      value: ind.value,
      signal: ind.signal,
      description: ind.description,
    }));
    const { error: signalsError } = await svc.from("macro_signals").upsert(rows, { onConflict: "week_of,indicator" });
    if (signalsError) {
      return NextResponse.json(
        { error: signalsError.message, code: signalsError.code, details: signalsError.details },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ danger_score, regime, signals_triggered, summary, indicators });
}
