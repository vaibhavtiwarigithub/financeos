/**
 * macro-sentinel — Supabase Edge Function
 *
 * Schedule: Every Monday at 08:00 UTC (pg_cron)
 * Purpose:  Fetch 8 Alpha Vantage macro indicators → compute regime score
 *           → upsert macro_regime + macro_signals tables
 *
 * Ported from app/api/agents/macro-sentinel/route.ts
 * No LLM calls — pure data + math.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPaused, pausedResponse } from "../_shared/pause-check.ts";

function jsonOk(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}
function jsonError(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json" } });
}

const AV_BASE = "https://www.alphavantage.co/query";

async function avFetch(fn: string, avKey: string, params = ""): Promise<any> {
  const res = await fetch(`${AV_BASE}?function=${fn}&apikey=${avKey}${params}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`AV ${fn} HTTP ${res.status}`);
  return res.json();
}

interface Indicator {
  name: string;
  value: number | null;
  signal: "green" | "yellow" | "orange" | "red";
  description: string;
  weight: number;
}

async function fetchIndicators(avKey: string): Promise<Indicator[]> {
  const indicators: Indicator[] = [];

  // 1. Yield curve (10Y - 2Y)
  try {
    const [y2, y10] = await Promise.all([
      avFetch("TREASURY_YIELD", avKey, "&interval=monthly&maturity=2year"),
      avFetch("TREASURY_YIELD", avKey, "&interval=monthly&maturity=10year"),
    ]);
    if (y2?.Note || y2?.Information || y10?.Note || y10?.Information) throw new Error("rate_limited");
    const rate2 = parseFloat(y2?.data?.[0]?.value);
    const rate10 = parseFloat(y10?.data?.[0]?.value);
    if (isNaN(rate2) || isNaN(rate10)) throw new Error("bad_values");
    const spread = rate10 - rate2;
    let signal: Indicator["signal"] = "green";
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

  // 2. Sahm Rule (unemployment)
  try {
    const data = await avFetch("UNEMPLOYMENT", avKey);
    const readings = (data?.data ?? []).slice(0, 13).map((d: any) => parseFloat(d.value));
    if (readings.length >= 4) {
      const recent3avg = (readings[0] + readings[1] + readings[2]) / 3;
      const min12 = Math.min(...readings.slice(0, 12));
      const sahm = recent3avg - min12;
      let signal: Indicator["signal"] = "green";
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

  // 3. Nonfarm Payrolls
  try {
    const data = await avFetch("NONFARM_PAYROLL", avKey);
    const vals = (data?.data ?? []).slice(0, 4).map((d: any) => parseFloat(d.value));
    if (vals.length >= 1) {
      const trend3 = vals.slice(0, 3).filter((v: number) => v < 100).length;
      const latest = vals[0];
      let signal: Indicator["signal"] = "green";
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
    const data = await avFetch("REAL_GDP", avKey, "&interval=quarterly");
    const vals = (data?.data ?? []).slice(0, 3).map((d: any) => parseFloat(d.value));
    if (vals.length >= 2) {
      const growthPct = ((vals[0] - vals[1]) / vals[1]) * 100;
      let signal: Indicator["signal"] = "green";
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

  // 5. CPI Inflation
  try {
    const data = await avFetch("CPI", avKey, "&interval=monthly");
    const vals = (data?.data ?? []).slice(0, 3).map((d: any) => parseFloat(d.value));
    if (vals.length >= 2) {
      const yoyPct = ((vals[0] - vals[1]) / vals[1]) * 100;
      let signal: Indicator["signal"] = "green";
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
    const data = await avFetch("RETAIL_SALES", avKey);
    const vals = (data?.data ?? []).slice(0, 4).map((d: any) => parseFloat(d.value));
    if (vals.length >= 2) {
      const mom = ((vals[0] - vals[1]) / vals[1]) * 100;
      const declines = vals.slice(0, 3).filter((v: number, i: number, a: number[]) => i > 0 && v < a[i - 1]).length;
      let signal: Indicator["signal"] = "green";
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

  // 7. Federal Funds Rate
  try {
    const data = await avFetch("FEDERAL_FUNDS_RATE", avKey, "&interval=monthly");
    const vals = (data?.data ?? []).slice(0, 6).map((d: any) => parseFloat(d.value));
    if (vals.length >= 1) {
      const latest = vals[0];
      const sixMoAgo = vals[5] ?? vals[vals.length - 1];
      const rising = latest > sixMoAgo;
      let signal: Indicator["signal"] = "green";
      if (latest > 5 && rising) signal = "orange";
      else if (latest > 4.5 || latest > 5) signal = "yellow";
      indicators.push({
        name: "Federal Funds Rate",
        value: latest,
        signal,
        description: `Current: ${latest.toFixed(2)}%. ${rising ? "Rising (tightening)" : "Falling/flat (easing)"}. High rates pressure growth.`,
        weight: 2,
      });
    }
  } catch {}

  // 8. Durable Goods Orders
  try {
    const data = await avFetch("DURABLES", avKey);
    const vals = (data?.data ?? []).slice(0, 3).map((d: any) => parseFloat(d.value));
    if (vals.length >= 2) {
      const mom = ((vals[0] - vals[1]) / vals[1]) * 100;
      let signal: Indicator["signal"] = "green";
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
    totalWeight += 3 * ind.weight;
    if (ind.signal !== "green") signals_triggered++;
  }

  if (indicators.length < 3) {
    return { danger_score: 0, regime: "green", signals_triggered: 0 };
  }

  const danger_score = totalWeight > 0 ? Math.round((weightedScore / totalWeight) * 100) : 0;

  let regime: "green" | "yellow" | "orange" | "red" = "green";
  if (danger_score >= 60) regime = "red";
  else if (danger_score >= 40) regime = "orange";
  else if (danger_score >= 20) regime = "yellow";

  const highSignals = indicators.filter(
    (i) => i.weight === 3 && (i.signal === "red" || i.signal === "orange")
  );
  if (highSignals.length >= 2 && regime === "yellow") regime = "orange";

  return { danger_score, regime, signals_triggered };
}

serve(async (req) => {
  // Auth: Bearer cron secret
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) return jsonError("Unauthorized", 401);

  const avKey = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? "";
  if (!avKey) return jsonError("Missing ALPHA_VANTAGE_API_KEY", 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Pause gate — stop immediately if app paused
  const { paused, reason } = await checkPaused(supabase);
  if (paused) return pausedResponse(reason);

  const weekOf = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Idempotency: skip if already ran this week with good data
  const { data: existing } = await supabase
    .from("macro_regime")
    .select("id, signals_triggered")
    .eq("week_of", weekOf)
    .single();

  if (existing && existing.signals_triggered > 0) {
    return jsonOk({ message: "Already ran this week", cached: true });
  }

  // Delete incomplete run so we can retry clean
  if (existing) {
    await supabase.from("macro_regime").delete().eq("week_of", weekOf);
    await supabase.from("macro_signals").delete().eq("week_of", weekOf);
  }

  const indicators = await fetchIndicators(avKey);
  const { danger_score, regime, signals_triggered } = computeRegime(indicators);

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

  const { error: regimeError } = await supabase.from("macro_regime").upsert(
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

  if (regimeError) return jsonError(regimeError.message, 500);

  if (indicators.length) {
    const rows = indicators.map((ind) => ({
      week_of: weekOf,
      indicator: ind.name,
      value: ind.value,
      signal: ind.signal,
      description: ind.description,
    }));
    const { error: signalsError } = await supabase
      .from("macro_signals")
      .upsert(rows, { onConflict: "week_of,indicator" });
    if (signalsError) return jsonError(signalsError.message, 500);
  }

  return jsonOk({ danger_score, regime, signals_triggered, summary, indicators });
});
