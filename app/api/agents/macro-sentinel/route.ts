import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

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
    const rate2 = parseFloat(y2?.data?.[0]?.value ?? "0");
    const rate10 = parseFloat(y10?.data?.[0]?.value ?? "0");
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
  danger_score: number;
  regime: "green" | "yellow" | "orange" | "red";
  signals_triggered: number;
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

  return { danger_score, regime, signals_triggered };
}

export async function GET() {
  return NextResponse.json({ message: "Use POST to run MacroSentinel" });
}

export async function POST() {
  const svc = createServiceClient();
  const weekOf = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD

  // Check if already ran this week
  const { data: existing } = await svc
    .from("macro_regime")
    .select("id")
    .eq("week_of", weekOf)
    .single();
  if (existing) return NextResponse.json({ message: "Already ran this week", cached: true });

  const indicators = await fetchIndicators();
  const { danger_score, regime, signals_triggered } = computeRegime(indicators);

  // Build summary
  const topSignals = indicators
    .filter((i) => i.signal !== "green")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((i) => `${i.name}: ${i.signal.toUpperCase()}`)
    .join("; ");

  const summary =
    signals_triggered === 0
      ? "No recession signals. Economy in expansion."
      : `${signals_triggered} signal(s) triggered. Top: ${topSignals}`;

  // Upsert regime
  const { error: regimeError } = await svc.from("macro_regime").upsert(
    {
      week_of: weekOf,
      danger_score,
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
