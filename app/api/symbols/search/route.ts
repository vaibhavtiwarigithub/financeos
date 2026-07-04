import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type SymbolResult = { symbol: string; name: string; exchange: string; locale: string };

export async function GET(req: NextRequest) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ results: [] });

  const key = process.env.MASSIVE_API_KEY;
  if (key) {
    try {
      const url = `https://api.massive.com/v3/reference/tickers?search=${encodeURIComponent(q)}&active=true&limit=8&apiKey=${key}`;
      const res = await fetch(url, { next: { revalidate: 3600 } });
      if (res.ok) {
        const data = await res.json();
        const raw: Array<{ ticker?: string; name?: string; primary_exchange?: string; locale?: string; market?: string }> =
          Array.isArray(data?.results) ? data.results : [];
        const results: SymbolResult[] = raw
          .filter((r) => r.ticker)
          .map((r) => ({
            symbol: (r.ticker || "").toUpperCase(),
            name: r.name || "",
            exchange: r.primary_exchange || r.market || "",
            locale: r.locale || "",
          }));
        if (results.length > 0) {
          return NextResponse.json({ results });
        }
      }
    } catch {
      // fall through to client-side fallback
    }
  }

  // Signal to client to fall back to filtering existing watchlist items.
  return NextResponse.json({ results: [], fallback: true });
}
