import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { tryProviders, type NewsResult } from "@/lib/data/provider-interface";

export const dynamic = "force-dynamic";

function safeUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizePublishedAt(value?: string): string | null {
  if (!value) return null;
  // Alpha Vantage uses YYYYMMDDTHHMMSS; most other providers use ISO-ish dates.
  const av = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  const parsed = av ? new Date(`${av[1]}-${av[2]}-${av[3]}T${av[4]}:${av[5]}:${av[6]}Z`) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  const market = req.nextUrl.searchParams.get("market") === "india" ? "india" : "us";
  if (!/^[A-Z0-9.-]{1,20}$/.test(symbol)) return NextResponse.json({ error: "invalid symbol" }, { status: 400 });

  // Current enrichment is intentionally on-demand. Providers are already
  // budget-guarded/day-cached; FMP is tried first to preserve scarce AV calls.
  // India returns an honest gap until a validated NSE-news adapter is wired.
  let provider = "none";
  let rows: NewsResult[] | null = null;
  if (market === "us") {
    rows = await tryProviders(["fmp", "alpha_vantage"], async p => {
      const result = await p.fetchNews(symbol, 8);
      if (result?.length) provider = p.label;
      return result?.length ? result : null;
    });
  }

  const seen = new Set<string>();
  const items = (rows ?? []).flatMap(item => {
    const title = String(item.title ?? "").trim();
    const url = safeUrl(item.url);
    const key = normalizeTitle(title);
    if (!title || !url || !key || seen.has(key)) return [];
    seen.add(key);
    return [{
      title: title.slice(0, 220), summary: item.summary?.slice(0, 360) ?? null,
      url, published_at: normalizePublishedAt(item.publishedAt),
      sentiment: item.sentiment ?? null,
    }];
  }).slice(0, 5);

  return NextResponse.json({
    symbol, market, fetched_at: new Date().toISOString(), provider,
    items, available: items.length > 0,
    message: items.length ? null : market === "india"
      ? "Current India news is not available from a validated free adapter yet. Use the NSE/Yahoo links and company announcements for verification."
      : "No current provider-backed headlines were available. This does not mean there is no news.",
    disclaimer: "Current context fetched after the historical decision; it did not influence the recorded score or action.",
  });
}
