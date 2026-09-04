import { isEtfSymbol } from "@/lib/asset-classification";
import { isLeveragedInverseEtf } from "@/lib/trading/symbol-policy";

export const INSTRUMENT_TAXONOMY_VERSION = "instrument-taxonomy.v1";

export type InstrumentFamily =
  | "operating_company"
  | "adr"
  | "bank"
  | "reit"
  | "broad_equity_etf"
  | "sector_etf"
  | "thematic_etf"
  | "fixed_income_etf"
  | "gold_bullion_fund"
  | "silver_bullion_fund"
  | "gold_miners_fund"
  | "metal_producer_equity"
  | "royalty_streaming_equity"
  | "india_etf"
  | "leveraged_or_inverse_etf"
  // Stage 1 (2026-09-04): paper-only, scoreMode=blocked until Stage 2 evidence clears.
  // Uses CRYPTO_SESSION_CUTOFF_UTC, NOT America/New_York — see lib/data/crypto-session.ts.
  | "crypto"
  | "unknown";

export type InstrumentPolicy = {
  market: "us" | "india";
  symbol: string;
  family: InstrumentFamily;
  exposureId: string;
  benchmarkSymbol: string | null;
  source: "curated" | "sector_derived" | "legacy_derived" | "unknown";
  confidence: "curated" | "derived" | "unknown";
  version: typeof INSTRUMENT_TAXONOMY_VERSION;
  scoreMode: "legacy_v1" | "measure_only" | "blocked";
};

// Stage 1 (2026-09-04): BTC+ETH+SOL approved. scoreMode=blocked; paper pool $10k separate.
// Expand after Stage 2 evidence clears. Symbols are RH's hyphenated format.
const CRYPTO_SYMBOLS = new Set(["BTC-USD", "ETH-USD", "SOL-USD"]);

const GOLD_BULLION = new Set(["GLD", "IAU"]);
const SILVER_BULLION = new Set(["SLV"]);
const GOLD_MINERS_FUNDS = new Set(["GDX", "GDXJ"]);
const METAL_PRODUCERS = new Set(["KGC", "NEM", "AEM", "GOLD", "AU", "AGI", "HL", "PAAS"]);
const ROYALTY_STREAMERS = new Set(["FNV", "WPM", "RGLD"]);
const BROAD_EQUITY_ETFS = new Set(["SPY", "VOO", "VTI", "IVV", "IWM", "DIA", "RSP", "VT", "ACWI", "EFA", "VXUS"]);
const SECTOR_ETFS = new Set(["XLK", "XLF", "XLE", "XLI", "XLV", "XLU", "XLRE", "XLB", "XLC", "XLP", "XLY", "SMH", "SOXX", "IBB", "KRE", "KBE", "ITB", "XME"]);
const FIXED_INCOME_ETFS = new Set(["TLT", "SHY", "IEF", "HYG", "LQD", "BND", "AGG", "GOVT", "SGOV"]);

const INDIA_ETFS: ReadonlyMap<string, { exposure: string; benchmark: string | null }> = new Map([
  ["GOLDBEES.NS", { exposure: "gold_spot_inr", benchmark: null }],
  ["SILVERBEES.NS", { exposure: "silver_spot_inr", benchmark: null }],
  ["LIQUIDBEES.NS", { exposure: "india_cash", benchmark: null }],
  ["NIFTYBEES.NS", { exposure: "india_index:nifty50", benchmark: "^NSEI" }],
  ["JUNIORBEES.NS", { exposure: "india_index:nifty_next50", benchmark: null }],
  ["BANKBEES.NS", { exposure: "india_sector:banks", benchmark: "^NSEBANK" }],
  ["ITBEES.NS", { exposure: "india_sector:technology", benchmark: "^CNXIT" }],
]);

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function policy(
  market: "us" | "india",
  symbol: string,
  family: InstrumentFamily,
  exposureId: string,
  benchmarkSymbol: string | null,
  source: InstrumentPolicy["source"],
  confidence: InstrumentPolicy["confidence"],
): InstrumentPolicy {
  return {
    market, symbol, family, exposureId, benchmarkSymbol, source, confidence,
    version: INSTRUMENT_TAXONOMY_VERSION,
    scoreMode: family === "leveraged_or_inverse_etf" || family === "unknown" || family === "crypto"
      ? "blocked"
      : ["gold_bullion_fund", "silver_bullion_fund", "gold_miners_fund", "india_etf"].includes(family)
        ? "measure_only"
        : "legacy_v1",
  };
}

export function classifyInstrumentPolicy(input: {
  symbol: string;
  market: "us" | "india";
  isAdr?: boolean;
  sector?: string | null;
  industry?: string | null;
}): InstrumentPolicy {
  const symbol = input.symbol.trim().toUpperCase();
  const sector = normalized(input.sector);
  const industry = normalized(input.industry);

  if (!symbol) return policy(input.market, symbol, "unknown", "unknown", null, "unknown", "unknown");

  // Crypto: market stays "us" (RH USD settlement), family="crypto", always blocked.
  // Uses CRYPTO_SESSION_CUTOFF_UTC — never America/New_York session logic.
  if (CRYPTO_SYMBOLS.has(symbol)) return policy("us", symbol, "crypto", `crypto:${symbol}`, null, "curated", "curated");

  if (input.market === "india") {
    const fund = INDIA_ETFS.get(symbol);
    if (fund) return policy("india", symbol, "india_etf", fund.exposure, fund.benchmark, "curated", "curated");
    if (/reit|real estate investment trust/.test(industry)) return policy("india", symbol, "reit", "india_reit", null, "sector_derived", "derived");
    if (/bank|financial services/.test(sector) || /bank/.test(industry)) return policy("india", symbol, "bank", "india_banks", "^NSEBANK", "sector_derived", "derived");
    return policy("india", symbol, "operating_company", "india_equity", "^NSEI", "legacy_derived", "derived");
  }

  if (isLeveragedInverseEtf(symbol)) return policy("us", symbol, "leveraged_or_inverse_etf", `leveraged:${symbol}`, null, "curated", "curated");
  if (GOLD_BULLION.has(symbol)) return policy("us", symbol, "gold_bullion_fund", "gold_spot", "GLD", "curated", "curated");
  if (SILVER_BULLION.has(symbol)) return policy("us", symbol, "silver_bullion_fund", "silver_spot", "SLV", "curated", "curated");
  if (GOLD_MINERS_FUNDS.has(symbol)) return policy("us", symbol, "gold_miners_fund", "gold_miners", "GDX", "curated", "curated");
  if (METAL_PRODUCERS.has(symbol)) return policy("us", symbol, "metal_producer_equity", "gold_miners", "GDX", "curated", "curated");
  if (ROYALTY_STREAMERS.has(symbol)) return policy("us", symbol, "royalty_streaming_equity", "gold_royalty_streaming", "GDX", "curated", "curated");
  if (BROAD_EQUITY_ETFS.has(symbol)) return policy("us", symbol, "broad_equity_etf", "us_broad_equity", "SPY", "curated", "curated");
  if (SECTOR_ETFS.has(symbol)) return policy("us", symbol, "sector_etf", `us_sector:${symbol}`, "SPY", "curated", "curated");
  if (FIXED_INCOME_ETFS.has(symbol)) return policy("us", symbol, "fixed_income_etf", `us_rates:${symbol}`, "AGG", "curated", "curated");
  if (isEtfSymbol(symbol)) return policy("us", symbol, "thematic_etf", `us_fund:${symbol}`, "SPY", "legacy_derived", "derived");
  if (input.isAdr) return policy("us", symbol, "adr", "us_adr_equity", "SPY", "curated", "curated");
  if (/reit|real estate investment trust/.test(industry)) return policy("us", symbol, "reit", "us_reit", "XLRE", "sector_derived", "derived");
  if (/bank/.test(industry)) return policy("us", symbol, "bank", "us_banks", "KBE", "sector_derived", "derived");
  return policy("us", symbol, "operating_company", "us_equity", "SPY", "legacy_derived", "derived");
}

export function isFundFamily(family: InstrumentFamily): boolean {
  return family.endsWith("_etf") || family.endsWith("_fund");
}

export function isMetalFamily(family: InstrumentFamily): boolean {
  return ["gold_bullion_fund", "silver_bullion_fund", "gold_miners_fund", "metal_producer_equity", "royalty_streaming_equity"].includes(family);
}
