// Canonical deterministic classification shared by research and display paths.
// Guessing from missing fundamentals caused ETFs to be shown as companies and
// wasted provider calls on structurally inapplicable dimensions.
export const KNOWN_US_ETFS = new Set([
  "SPY","VOO","QQQ","IWM","VTI","DIA","RSP","IVV","SCHD","VTV","VONG","SPHQ","SPMO","SGOV","DBA",
  "XLK","XLF","XLE","XLI","XLV","XLU","XLRE","XLB","XLC","XLP","XLY","SMH","SOXX","IBB","KRE","KBE","ITB","XME",
  "BOTZ","AIQ","ICLN","NLR","ARKK","ARKG","ARKW","ARKF","ARKX","CIBR","ROBO","SKYY","WCLD","BUG","REMX","TEM",
  "TQQQ","SOXL","SPXL","UPRO","TECL","FAS","DUSL","DRN","UGL","FNGU","LABU","HIBL","MSTU","NVDL",
  "SQQQ","SOXS","SPXS","SPDN","FAZ","SIJ","DRV","GLL","SDOW","FNGD","LABD","HIBS","MSTZ","NVDD",
  "USO","GLD","SLV","UNG","PDBC","IAU","GDX","GDXJ",
  "TLT","SHY","IEF","HYG","LQD","BND","AGG","GOVT",
  "IBIT","BITO","GBTC","MAGS","CONY","MSFO",
  "INDA","EPI","INDY","EUAD","FEZ","VGK","EWG","EWL","EWU","EWQ","DXJ","EWJ","EWT","EWY","EWH","FXI","ASHR","EMXC",
  "VT","ACWI","EFA","VXUS",
]);

export function isEtfSymbol(symbol: string): boolean {
  return KNOWN_US_ETFS.has(symbol.trim().toUpperCase());
}

export type JournalAssetType = "company" | "adr" | "etf" | "india_company" | "metal_fund";

export function classifyJournalAsset(symbol: string, recordedClass?: string | null): JournalAssetType {
  const upper = symbol.trim().toUpperCase();
  if (recordedClass === "metal") return "metal_fund";
  if (recordedClass === "etf" || isEtfSymbol(upper)) return "etf";
  if (recordedClass === "india" || upper.endsWith(".NS") || upper.endsWith(".BO")) return "india_company";
  if (recordedClass === "adr") return "adr";
  return "company";
}
