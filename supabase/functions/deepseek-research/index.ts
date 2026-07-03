import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPaused, pausedResponse } from "../_shared/pause-check.ts";

const CRON_SECRET = "fos-cron-k9x2m7p4-2026";

async function fetchAVOverview(symbol: string, avKey: string): Promise<Record<string, string>> {
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=COMPANY_OVERVIEW&symbol=${symbol}&apikey=${avKey}`, { signal: AbortSignal.timeout(10000) });
    return await r.json();
  } catch { return {}; }
}

async function fetchRSI(symbol: string, avKey: string): Promise<number | null> {
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=weekly&time_period=14&series_type=close&apikey=${avKey}`, { signal: AbortSignal.timeout(10000) });
    const json = await r.json();
    const entries = Object.entries(json?.["Technical Analysis: RSI"] ?? {});
    if (!entries.length) return null;
    const [, val] = entries[0];
    return parseFloat((val as Record<string, string>)["RSI"] ?? "0");
  } catch { return null; }
}

async function callDeepSeek(messages: any[], dsKey: string): Promise<string> {
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${dsKey}` },
    body: JSON.stringify({ model: "deepseek-chat", messages, max_tokens: 512, temperature: 0.3 }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await r.json();
  return json?.choices?.[0]?.message?.content ?? "";
}

serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.includes(CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { paused, reason } = await checkPaused(supabase);
  if (paused) return pausedResponse(reason);

  const avKey = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? "";
  const dsKey = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
  if (!avKey || !dsKey) {
    return new Response(JSON.stringify({ error: "Missing ALPHA_VANTAGE_API_KEY or DEEPSEEK_API_KEY" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  // Get watchlist symbols
  const { data: watchlist } = await supabase.from("watchlist").select("symbol").limit(20);
  const symbols = (watchlist ?? []).map((w: any) => w.symbol as string).filter(Boolean);

  if (symbols.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0, reason: "Empty watchlist" }), { headers: { "Content-Type": "application/json" } });
  }

  const processed: string[] = [];
  const errors: string[] = [];

  for (const symbol of symbols) {
    try {
      const [overview, rsi] = await Promise.all([
        fetchAVOverview(symbol, avKey),
        fetchRSI(symbol, avKey),
      ]);

      if (!overview.Symbol) { errors.push(`${symbol}: no overview`); continue; }

      const peRatio = overview.PERatio ? `P/E: ${overview.PERatio}` : "";
      const eps = overview.EPS ? `EPS: ${overview.EPS}` : "";
      const sector = overview.Sector ?? "";
      const rsiStr = rsi != null ? `RSI(14): ${rsi.toFixed(1)}` : "";
      const description = overview.Description ? overview.Description.slice(0, 300) : "";

      const content = `Analyze ${symbol} (${sector}) for short-term trading opportunity.
${description}
Fundamentals: ${peRatio} | ${eps}
Technicals: ${rsiStr}

Reply in JSON: { "direction": "long"|"short"|"neutral", "summary": "2-sentence thesis", "risks": ["risk1","risk2"], "score": 0-100 }
Score 65+ = actionable. Score under 65 = neutral. No fabricated numbers.`;

      const result = await callDeepSeek([
        { role: "system", content: "You are a terse equity analyst. Reply only JSON." },
        { role: "user", content },
      ], dsKey);

      let parsed: any = {};
      try { parsed = JSON.parse(result.trim().replace(/^```json?\n?/, "").replace(/```$/, "")); }
      catch { errors.push(`${symbol}: parse error`); continue; }

      const direction = parsed.direction ?? "neutral";
      const score = Math.max(0, Math.min(100, parseInt(String(parsed.score ?? 50))));
      const summary = parsed.summary ?? "";
      const risks = parsed.risks ?? [];

      await supabase.from("agent_signals").insert({
        symbol,
        agent_label: "deepseek",
        direction,
        analyst_score: score,
        summary,
        risks: JSON.stringify(risks),
        raw_llm_output: result.slice(0, 2000),
        created_at: new Date().toISOString(),
      });

      processed.push(symbol);
    } catch (e: any) {
      errors.push(`${symbol}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify({ ok: true, processed, errors }), {
    headers: { "Content-Type": "application/json" },
  });
});
