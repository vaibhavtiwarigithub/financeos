// Tradable-universe policy. A symbol is blocked when it is a leveraged/inverse
// ETF (auto, both markets — daily-rebalance decay makes them unfit for a 2-20d
// swing hold, and inverse = de-facto shorting which violates long-only) OR it is
// on the owner's symbol_blocklist (curated / meme / etc). Enforced at three
// layers: research candidate selection, paper/trader eligibility, and the live
// execution gateway (defense in depth).
import type { SupabaseClient } from "@supabase/supabase-js";

// Leveraged (2x/3x) + inverse US ETFs. NSE has effectively no leveraged ETFs, so
// this is US-centric; the DB blocklist covers any India-specific names.
export const LEVERAGED_INVERSE_ETFS = new Set<string>([
  // Unleveraged inverse. These remain blocked from every generic agent flow;
  // the paper-only downside-hedge controller has its own narrow SH/PSQ RPC.
  "SH", "PSQ", "DOG", "RWM",
  // 3x bull
  "TQQQ", "SOXL", "SPXL", "UPRO", "TECL", "FAS", "LABU", "TNA", "UDOW", "DFEN",
  "YINN", "NUGT", "JNUG", "BOIL", "FNGU", "NVDL", "MSTU", "TSLL", "WEBL", "HIBL",
  "DPST", "DRN", "CURE", "RETL", "NAIL", "UMDD", "URTY", "GUSH", "DUSL", "ERX",
  // 3x bear / inverse
  "SQQQ", "SOXS", "SPXS", "SPXU", "TECS", "FAZ", "LABD", "TZA", "SDOW", "YANG",
  "DUST", "JDST", "KOLD", "FNGD", "NVDD", "MSTZ", "TSLQ", "WEBS", "HIBS", "DRV",
  "ERY", "SRTY", "SMDD", "SPDN",
  // 2x
  "QLD", "SSO", "UWM", "ROM", "DDM", "SAA", "UGL", "AGQ", "BITX", "ETHU",
  "QID", "SDS", "TWM", "REW", "DXD", "GLL", "ZSL", "SCO", "SVXY", "UVXY", "VIXY",
]);

export function isLeveragedInverseEtf(symbol: string): boolean {
  return LEVERAGED_INVERSE_ETFS.has(symbol.trim().toUpperCase());
}

// Blocked-symbol check. `market` is the order/candidate market. Combines the
// code-level leveraged/inverse rule with the DB blocklist ('all' or that market).
// Fails OPEN on a DB read error for research (don't block scoring on a glitch),
// but callers on the MONEY path should treat an error as blocked — see opts.
export async function isSymbolBlocked(
  svc: SupabaseClient,
  symbol: string,
  market: "us" | "india",
  opts: { failClosed?: boolean } = {},
): Promise<{ blocked: boolean; reason?: string }> {
  const sym = symbol.trim().toUpperCase();
  if (market === "us" && isLeveragedInverseEtf(sym)) {
    return { blocked: true, reason: "leveraged/inverse ETF (unfit for swing hold; long-only)" };
  }
  try {
    const bare = sym.replace(/\.(NS|BO)$/i, "");
    const { data, error } = await svc.from("symbol_blocklist")
      .select("symbol, category, reason, market")
      .in("market", [market, "all"]);
    if (error) return { blocked: !!opts.failClosed, reason: opts.failClosed ? `blocklist read failed: ${error.message}` : undefined };
    const hit = (data ?? []).find((r: any) => {
      const b = String(r.symbol ?? "").trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
      return b === bare || b === sym;
    });
    if (hit) return { blocked: true, reason: `blocklist: ${(hit as any).category ?? "owner"}${(hit as any).reason ? ` — ${(hit as any).reason}` : ""}` };
    return { blocked: false };
  } catch (e) {
    return { blocked: !!opts.failClosed, reason: opts.failClosed ? `blocklist error: ${String(e)}` : undefined };
  }
}
