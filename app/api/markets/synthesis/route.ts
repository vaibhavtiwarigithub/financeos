import { NextRequest, NextResponse } from "next/server";
import { callLLM } from "@/lib/llm-router";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { getConfiguredModel, isAgentEnabled } from "@/lib/agent-model-config";

export const dynamic = "force-dynamic";

// ETF proxies for the regime read. All quotes via Massive.
// Grouped so we can build the risk-on/neutral/risk-off score.
const REGIME_TICKERS = [
  "SPY", "QQQ", "IWM",   // equity breadth
  "TLT", "IEF",          // rates (long / intermediate treasuries)
  "HYG",                 // credit (high yield — paired with IEF as HYG/IEF ratio)
  "UUP",                 // US dollar / DXY proxy
  "GLD",                 // gold
  "VIXY",                // volatility
];

interface QuoteResult {
  symbol: string;
  close: number;
  open: number;
  changePct: number;
}

// Read the latest cached daily bar per regime ticker from price_cache. The
// daily price-cache-fill job (/api/agents/price-cache-fill) pre-fills the whole
// Markets universe pre-market, so on the normal path this is a single warm read
// with NO Massive traffic — the page never bursts the provider on load.
async function readCachedQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
  const svc = createServiceClient();
  const out = new Map<string, QuoteResult>();
  // One batch query; reduce to the most-recent row per symbol in JS.
  const { data } = await svc
    .from("price_cache")
    .select("symbol, date, open, close")
    .in("symbol", symbols)
    .order("date", { ascending: false });
  for (const row of data ?? []) {
    const sym = (row as { symbol: string }).symbol;
    if (out.has(sym)) continue; // rows are date-desc, first seen is latest
    const open = Number((row as { open: number }).open);
    const close = Number((row as { close: number }).close);
    if (!open || !close) continue;
    out.set(sym, { symbol: sym, open, close, changePct: ((close - open) / open) * 100 });
  }
  return out;
}

// Single-symbol live fetch used ONLY to backfill the few symbols still missing
// from the cache (e.g. before the day's first fill has run). Gated by the shared
// serverless-safe Massive lease so it can never burst past ~5/min — on a miss it
// simply returns null and that indicator degrades gracefully.
async function fetchQuotePaced(symbol: string, apiKey: string | undefined): Promise<QuoteResult | null> {
  if (!apiKey) return null;
  const svc = createServiceClient();
  try {
    const { data: slot } = await svc.rpc("try_acquire_provider_slot", {
      p_provider: "massive",
      p_min_interval_ms: 12_500,
    });
    if (slot !== true) return null; // slot busy — don't burst, leave it missing
  } catch {
    return null;
  }
  try {
    const res = await fetch(
      `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`,
      { headers: { Accept: "application/json" }, next: { revalidate: 900 } }
    );
    if (res.ok) {
      const data = await res.json();
      const r = data.results?.[0];
      if (r && r.o && r.c) {
        return {
          symbol,
          close: r.c,
          open: r.o,
          changePct: ((r.c - r.o) / r.o) * 100,
        };
      }
    }
  } catch {
    // fall through
  }
  return null;
}

interface Indicator {
  label: string;
  symbol: string;
  price: number | null;
  changePct: number | null;
  note: string;
}

function signedPct(v: number | null): string {
  if (v === null) return "N/A";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export async function GET(req: NextRequest) {
  // Require a logged-in user — this route spends Massive + DeepSeek quota and
  // writes via the service role, so it must not be anonymously forceable.
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const force = req.nextUrl.searchParams.get("force") === "true";
  const today = new Date().toISOString().slice(0, 10);
  const svc = createServiceClient();

  // Return cached synthesis unless force=true (keeps DeepSeek calls cheap)
  if (!force) {
    const { data: cached } = await svc
      .from("briefings")
      .select("content, created_at")
      .eq("date", today)
      .eq("session", "synthesis")
      .maybeSingle();

    if (cached) {
      try {
        const parsed = JSON.parse(cached.content);
        return NextResponse.json({ ...parsed, generatedAt: cached.created_at, cached: true });
      } catch {
        // stale non-JSON cache — fall through and regenerate
      }
    }
  }

  const apiKey = process.env.MASSIVE_API_KEY;

  // 1. Warm read from price_cache (filled daily by /api/agents/price-cache-fill).
  //    Normal page loads resolve entirely here — zero Massive calls, no burst.
  const q = await readCachedQuotes(REGIME_TICKERS);

  // 2. Backfill only the symbols still missing (e.g. before the day's first
  //    fill). Sequential + lease-gated so we never fire a concurrent burst that
  //    would 429 and leave the read degraded.
  const missing = REGIME_TICKERS.filter((sym) => !q.has(sym));
  for (const sym of missing) {
    const r = await fetchQuotePaced(sym, apiKey);
    if (r) q.set(sym, r);
  }

  const get = (sym: string) => q.get(sym) ?? null;

  // HYG/IEF ratio — credit appetite. Compare each ETF's daily direction.
  // Falling HYG relative to IEF = credit stress = risk-off.
  const hyg = get("HYG");
  const ief = get("IEF");
  let creditRatioPct: number | null = null;
  let creditNote = "HYG/IEF — credit appetite; falling = risk-off (credit stress)";
  if (hyg && ief && ief.open && ief.close) {
    const ratioPrev = hyg.open / ief.open;
    const ratioNow = hyg.close / ief.close;
    creditRatioPct = ((ratioNow - ratioPrev) / ratioPrev) * 100;
    creditNote = `HYG/IEF ratio ${signedPct(creditRatioPct)} — credit appetite; falling = risk-off (credit stress)`;
  }

  const spy = get("SPY");
  const qqq = get("QQQ");
  const iwm = get("IWM");
  const tlt = get("TLT");
  const uup = get("UUP");
  const gld = get("GLD");
  const vixy = get("VIXY");

  const indicators: Indicator[] = [
    { label: "S&P 500 (SPY)", symbol: "SPY", price: spy?.close ?? null, changePct: spy?.changePct ?? null, note: "Large-cap equity trend — the core risk gauge" },
    { label: "Nasdaq 100 (QQQ)", symbol: "QQQ", price: qqq?.close ?? null, changePct: qqq?.changePct ?? null, note: "Tech / growth leadership; outperformance = risk-on appetite" },
    { label: "Small Caps (IWM)", symbol: "IWM", price: iwm?.close ?? null, changePct: iwm?.changePct ?? null, note: "Breadth & risk appetite; small caps lead in healthy risk-on tapes" },
    { label: "Long Treasuries (TLT)", symbol: "TLT", price: tlt?.close ?? null, changePct: tlt?.changePct ?? null, note: "Rates / duration; rising TLT = falling long yields (flight to safety)" },
    { label: "Credit (HYG/IEF)", symbol: "HYG", price: hyg?.close ?? null, changePct: creditRatioPct, note: creditNote },
    { label: "US Dollar (UUP)", symbol: "UUP", price: uup?.close ?? null, changePct: uup?.changePct ?? null, note: "DXY proxy; a rising dollar tightens conditions and pressures risk assets" },
    { label: "Gold (GLD)", symbol: "GLD", price: gld?.close ?? null, changePct: gld?.changePct ?? null, note: "Safe-haven / real-rate hedge; strength alongside falling stocks = defensive" },
    { label: "Volatility (VIXY)", symbol: "VIXY", price: vixy?.close ?? null, changePct: vixy?.changePct ?? null, note: "Fear gauge; rising VIXY = rising hedging demand = risk-off" },
  ];

  const hasData = q.size > 0;

  // ── Simple regime scoring from breadth + credit + vol + dollar ──
  // Positive score = risk-on, negative = risk-off.
  let score = 0;
  let scored = 0;
  const add = (v: number | null, sign: 1 | -1) => {
    if (v === null) return;
    scored++;
    if (v > 0.05) score += sign;
    else if (v < -0.05) score -= sign;
  };
  add(spy?.changePct ?? null, 1);       // stocks up = risk-on
  add(qqq?.changePct ?? null, 1);
  add(iwm?.changePct ?? null, 1);        // small-cap breadth
  add(creditRatioPct, 1);                // credit appetite up = risk-on
  add(vixy?.changePct ?? null, -1);      // vol up = risk-off
  add(uup?.changePct ?? null, -1);       // dollar up = risk-off
  add(gld?.changePct ?? null, -1);       // gold up = defensive tilt

  let regime: "risk-on" | "neutral" | "risk-off" | "unknown" = "unknown";
  if (scored > 0) {
    regime = score >= 2 ? "risk-on" : score <= -2 ? "risk-off" : "neutral";
  }

  // ── Build grounded context string for the LLM ──
  let contextString: string;
  if (!hasData) {
    contextString = "Market data unavailable for this session.";
  } else {
    contextString = indicators
      .map((ind) => {
        const priceStr = ind.price !== null ? `$${ind.price.toFixed(2)}` : "N/A";
        return `${ind.label}: ${priceStr} (${signedPct(ind.changePct)}) — ${ind.note}`;
      })
      .join("\n");
  }

  let synthesis = "Synthesis unavailable — regime indicator data could not be fetched.";
  let model = "none";

  if (hasData && !(await isAgentEnabled(svc, "markets-synthesis"))) {
    synthesis = "Synthesis skipped — markets-synthesis is disabled in Settings -> Agents -> LLM Config.";
  } else if (hasData) {
    const coverageNote = scored < 7
      ? `\n\nDATA COVERAGE WARNING: only ${scored}/7 regime proxy signals were available this run (the rest failed to fetch). Explicitly note this coverage gap in your synthesis and temper your confidence accordingly — do not present a fully confident read when signals are missing.`
      : "";

    const prompt = `You are a macro strategist. Using ONLY the real regime indicator numbers below from the most recent session, write a 3-4 sentence market synthesis. Do NOT invent any events, data points, or numbers beyond what is provided.

COMPUTED REGIME READ: ${regime.toUpperCase()}

REGIME INDICATORS (most recent session, ETF proxies) — ${scored}/7 signals available:
${contextString}${coverageNote}

Write exactly:
1. What the numbers say — describe the current cross-asset picture (equity breadth, credit, rates, dollar, gold, volatility) and whether it points risk-on, neutral, or risk-off.
2. Near-term outlook — where markets are most likely heading over the next few sessions if this configuration holds.
3. The key risk — the single most important thing that would flip the read.

Be specific about which indicators are driving the read. No invented catalysts. Reference the actual directions above.${scored < 7 ? " If fewer than 7 of the 7 regime signals are available, say so plainly and reduce your confidence." : ""}`;

    const llmResult = await callLLM({
      task: "thesis",
      // Configurable from Settings -> Agents -> LLM Config (agent_name="markets-synthesis").
      model: await getConfiguredModel(svc, "markets-synthesis"),
      prompt,
      maxTokens: 350,
    });
    synthesis = llmResult.text?.trim() || synthesis;
    model = llmResult.model;
  }

  const generatedAt = new Date().toISOString();
  const payload = { regime, indicators, synthesis, signalsAvailable: scored, signalsTotal: 7 };

  // Only cache when a STRONG MAJORITY of the 7 regime proxies resolved. A
  // degraded read (most proxies null because the cache wasn't filled yet, or a
  // transient Massive failure) must NOT be frozen for the rest of the day — that
  // is exactly the bug this fixes: one sparse read poisoned the whole day's
  // synthesis until someone manually force-refreshed. Leaving a weak read
  // uncached lets the next fill/regen complete it.
  const STRONG_MAJORITY = 5; // of 7 scoring signals
  if (hasData && scored >= STRONG_MAJORITY) {
    await svc.from("briefings").upsert(
      { date: today, session: "synthesis", content: JSON.stringify(payload), model },
      { onConflict: "date,session" }
    );
  }

  return NextResponse.json({ ...payload, generatedAt, cached: false });
}
