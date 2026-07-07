import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";

// Phase 1: Corporate Actions sync
// Fetches splits + dividends from Alpha Vantage for held/watchlist symbols.
// Writes to corporate_actions table. Used by paper-trade NAV adjustment.

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const supabase = await import("@/lib/supabase/server").then(m => m.createClient());
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  if (!avKey) return NextResponse.json({ error: "No ALPHA_VANTAGE_API_KEY" }, { status: 500 });

  // Get symbols from open positions + watchlist
  const [{ data: positions }, { data: watchlist }] = await Promise.all([
    supabase.from("paper_positions").select("symbol"),
    supabase.from("watchlist").select("symbol").limit(20),
  ]);

  const symbols = [...new Set([
    ...(positions ?? []).map((p: any) => p.symbol as string),
    ...(watchlist ?? []).map((w: any) => w.symbol as string),
  ])].slice(0, 15); // AV free tier: 25 calls/day — keep budget

  const results: { symbol: string; splits: number; dividends: number }[] = [];
  const errors: { symbol: string; error: string }[] = [];

  for (const symbol of symbols) {
    try {
      // Fetch splits and dividends in parallel
      const [splitsRes, dividendsRes] = await Promise.all([
        fetch(`https://www.alphavantage.co/query?function=SPLITS&symbol=${symbol}&apikey=${avKey}`)
          .then(r => r.json()).catch(() => null),
        fetch(`https://www.alphavantage.co/query?function=DIVIDENDS&symbol=${symbol}&apikey=${avKey}`)
          .then(r => r.json()).catch(() => null),
      ]);

      let splitsAdded = 0;
      let dividendsAdded = 0;

      // Process splits
      const splitData: any[] = splitsRes?.data ?? [];
      for (const split of splitData.slice(0, 10)) {
        const exDate = split.effective_date ?? split.ex_date;
        if (!exDate) continue;
        const ratio = parseFloat(split.split_factor ?? split.ratio ?? "0");
        if (!ratio || ratio <= 0) continue;
        try {
          const { error } = await supabase.from("corporate_actions").upsert({
            symbol,
            action_type: "split",
            ex_date: exDate,
            split_ratio: ratio,
            source: "alpha_vantage",
            source_tier: 2,
          }, { onConflict: "symbol,action_type,ex_date" });
          if (!error) splitsAdded++;
        } catch { /* skip duplicate */ }
      }

      // Process dividends
      const divData: any[] = dividendsRes?.data ?? [];
      for (const div of divData.slice(0, 10)) {
        const exDate = div.ex_dividend_date ?? div.ex_date;
        if (!exDate) continue;
        const amount = parseFloat(div.amount ?? "0");
        if (!amount || amount <= 0) continue;
        try {
          const { error } = await supabase.from("corporate_actions").upsert({
            symbol,
            action_type: "dividend",
            ex_date: exDate,
            dividend_amount: amount,
            dividend_type: div.declaration_date ? "regular" : "regular",
            source: "alpha_vantage",
            source_tier: 2,
          }, { onConflict: "symbol,action_type,ex_date" });
          if (!error) dividendsAdded++;
        } catch { /* skip duplicate */ }
      }

      results.push({ symbol, splits: splitsAdded, dividends: dividendsAdded });
    } catch (e: any) {
      errors.push({ symbol, error: e?.message ?? "unknown" });
    }
  }

  return NextResponse.json({ success: true, symbols_processed: symbols.length, results, errors });
}

// GET: fetch corporate actions for a symbol
export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const symbol = req.nextUrl.searchParams.get("symbol");
  const type   = req.nextUrl.searchParams.get("type"); // 'split' | 'dividend'
  const since  = req.nextUrl.searchParams.get("since"); // date string

  let query = supabase
    .from("corporate_actions")
    .select("*")
    .order("ex_date", { ascending: false })
    .limit(50);

  if (symbol) query = query.eq("symbol", symbol);
  if (type)   query = query.eq("action_type", type);
  if (since)  query = query.gte("ex_date", since);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ actions: data ?? [] });
}
