import { liquidUniverse } from "@/lib/edges/universe";

const EDGE_IDS = ["rel_strength_6m", "high_52w_proximity", "volume_breakout"] as const;
const MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

export type RelativeStrengthDiscoveryContext = {
  edge_date: string;
  universe_id: string | null;
  relative_strength_z: number;
  high_52w_proximity_z: number;
  volume_breakout_z: number | null;
  composite: number;
};

type EdgeRow = {
  symbol: string;
  date: string;
  edge_id: string;
  z_value: number | string | null;
  universe_id: string | null;
};

export type RelativeStrengthCandidate = {
  symbol: string;
  context: RelativeStrengthDiscoveryContext;
};

const asFinite = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function rotatingLiquidOffset(
  market: "us" | "india",
  maxSymbols: number,
  date = new Date(),
): number {
  const pageSize = Math.max(1, maxSymbols);
  const pages = Math.max(1, Math.ceil(liquidUniverse(market).length / pageSize));
  const sessionOrdinal = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
  return (sessionOrdinal % pages) * pageSize;
}

export function selectRelativeStrengthCandidates(
  rows: EdgeRow[],
  now = new Date(),
  maxCandidates = 4,
): RelativeStrengthCandidate[] {
  const latestDate = rows.reduce((latest, row) => row.date > latest ? row.date : latest, "");
  const latestTime = Date.parse(`${latestDate}T00:00:00Z`);
  if (!latestDate || !Number.isFinite(latestTime) || now.getTime() - latestTime > MAX_AGE_MS) return [];

  const bySymbol = new Map<string, Map<string, EdgeRow>>();
  for (const row of rows) {
    if (row.date !== latestDate || !EDGE_IDS.includes(row.edge_id as (typeof EDGE_IDS)[number])) continue;
    const symbol = String(row.symbol).trim().toUpperCase();
    if (!symbol) continue;
    const values = bySymbol.get(symbol) ?? new Map<string, EdgeRow>();
    values.set(row.edge_id, row);
    bySymbol.set(symbol, values);
  }

  return [...bySymbol.entries()]
    .flatMap(([symbol, values]) => {
      const relativeStrength = asFinite(values.get("rel_strength_6m")?.z_value);
      const highProximity = asFinite(values.get("high_52w_proximity")?.z_value);
      if (relativeStrength == null || highProximity == null || relativeStrength <= 0 || highProximity <= 0) return [];
      const volume = asFinite(values.get("volume_breakout")?.z_value);
      const composite = 0.65 * relativeStrength + 0.35 * highProximity;
      return [{
        symbol,
        context: {
          edge_date: latestDate,
          universe_id: values.get("rel_strength_6m")?.universe_id ?? null,
          relative_strength_z: Number(relativeStrength.toFixed(6)),
          high_52w_proximity_z: Number(highProximity.toFixed(6)),
          volume_breakout_z: volume == null ? null : Number(volume.toFixed(6)),
          composite: Number(composite.toFixed(6)),
        },
      }];
    })
    .sort((a, b) => b.context.composite - a.context.composite || a.symbol.localeCompare(b.symbol))
    .slice(0, Number.isFinite(maxCandidates) ? Math.max(0, Math.min(6, maxCandidates)) : 4);
}

// Reuses EdgeScout's persisted completed-session evidence. It creates no market
// data call and returns no candidates when the evidence is absent or stale.
export async function fetchRelativeStrengthCandidates(
  supabase: any,
  maxCandidates = 4,
): Promise<RelativeStrengthCandidate[]> {
  try {
    const { data, error } = await supabase
      .from("edge_signals")
      .select("symbol,date,edge_id,z_value,universe_id")
      .eq("market", "us")
      .in("edge_id", EDGE_IDS)
      .order("date", { ascending: false })
      .limit(600);
    if (error) return [];
    return selectRelativeStrengthCandidates((data ?? []) as EdgeRow[], new Date(), maxCandidates);
  } catch {
    return [];
  }
}
