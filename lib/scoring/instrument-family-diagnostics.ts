export const INSTRUMENT_DIAGNOSTIC_VERSION = "instrument-family-diagnostics.v1";

export type FamilyDiagnosticRow = {
  observationId: number;
  market: "us" | "india";
  symbol: string;
  family: string;
  exposureId: string;
  ts: string;
  score: number | null;
  labels: Partial<Record<5 | 10 | 20, number | null>>;
};

function sessionDate(ts: string, market: "us" | "india"): string {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "invalid";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}

export function buildInstrumentFamilyDiagnostics(rows: FamilyDiagnosticRow[]) {
  const latestBySymbolSession = new Map<string, FamilyDiagnosticRow>();
  for (const row of rows) {
    const key = `${row.market}|${row.symbol}|${sessionDate(row.ts, row.market)}`;
    const current = latestBySymbolSession.get(key);
    if (!current || Date.parse(row.ts) > Date.parse(current.ts)) latestBySymbolSession.set(key, row);
  }

  const groups = new Map<string, FamilyDiagnosticRow[]>();
  for (const row of latestBySymbolSession.values()) {
    const key = `${row.market}|${row.family}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.entries()].map(([key, observations]) => {
    const [market, family] = key.split("|");
    // GLD and IAU on the same day are one gold exposure sample. Collapse at
    // exposure-session before computing prediction variance or label counts;
    // otherwise substitute vehicles falsely inflate the evidence gate.
    const latestByExposureSession = new Map<string, FamilyDiagnosticRow>();
    for (const row of observations) {
      const exposureKey = `${row.exposureId}|${sessionDate(row.ts, row.market)}`;
      const current = latestByExposureSession.get(exposureKey);
      if (!current || Date.parse(row.ts) > Date.parse(current.ts)
        || (row.ts === current.ts && row.symbol.localeCompare(current.symbol) < 0)) {
        latestByExposureSession.set(exposureKey, row);
      }
    }
    const exposureObservations = [...latestByExposureSession.values()];
    const scores = exposureObservations.map((row) => row.score).filter((value): value is number => value != null && Number.isFinite(value));
    const labelCounts = Object.fromEntries(([5, 10, 20] as const).map((horizon) => [
      horizon,
      exposureObservations.filter((row) => Number.isFinite(row.labels[horizon])).length,
    ]));
    const stddev = standardDeviation(scores);
    const reasons: string[] = [];
    if (exposureObservations.length < 60) reasons.push(`needs 60 independent exposure-sessions; has ${exposureObservations.length}`);
    if (Math.max(...Object.values(labelCounts)) < 30) reasons.push(`needs 30 clean labels at one horizon; best is ${Math.max(...Object.values(labelCounts))}`);
    if (stddev == null || stddev < 0.5) reasons.push(`score variance is degenerate (sample sd ${stddev == null ? "n/a" : stddev.toFixed(3)})`);
    return {
      market,
      family,
      rawRows: rows.filter((row) => row.market === market && row.family === family).length,
      independentSymbolSessions: observations.length,
      independentExposureSessions: exposureObservations.length,
      symbols: [...new Set(observations.map((row) => row.symbol))].sort(),
      score: {
        min: scores.length ? Math.min(...scores) : null,
        max: scores.length ? Math.max(...scores) : null,
        sampleStdDev: stddev == null ? null : Number(stddev.toFixed(4)),
        cappedAt65Rate: scores.length ? Number((scores.filter((score) => score === 65).length / scores.length).toFixed(4)) : null,
      },
      matureLabels: labelCounts,
      readyForIc: reasons.length === 0,
      abstentionReasons: reasons,
    };
  }).sort((a, b) => `${a.market}|${a.family}`.localeCompare(`${b.market}|${b.family}`));
}

export const _test = { sessionDate, standardDeviation };
