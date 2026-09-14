// The risk dial, and the plain-English reasons behind a number.
//
// Shared by the page and the email so the two can never disagree about what a
// score means — a dial reading "Elevated" in one place and "Moderate" in the
// other would be worse than having no dial.
//
// ON DIRECTION. Seeking Alpha's dial is a RATING (Strong Sell → Strong Buy):
// green means "buy this". This dial is deliberately not that. It measures how
// much risk a portfolio is carrying, so green means "less concentrated, less
// leveraged to the market" — it is descriptive, never a suggestion to buy or
// sell anything. Same shape, opposite kind of claim, which is why the labels
// say Low/Moderate/Elevated/High rather than Buy/Hold/Sell.

export type RiskBand = "Low" | "Moderate" | "Elevated" | "High";

export const BAND_COLORS: Record<RiskBand, string> = {
  Low: "#22C55E",
  Moderate: "#84CC16",
  Elevated: "#EAB308",
  High: "#EF4444",
};

/** Bands are contiguous and cover 0-100, so no score can fall between them. */
export const BANDS: ReadonlyArray<{ band: RiskBand; upTo: number }> = [
  { band: "Low", upTo: 25 },
  { band: "Moderate", upTo: 50 },
  { band: "Elevated", upTo: 75 },
  { band: "High", upTo: 100 },
];

export function bandFor(score: number): RiskBand {
  const s = clampScore(score);
  for (const b of BANDS) if (s <= b.upTo) return b.band;
  return "High";
}

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

/**
 * Needle angle in degrees for a 180° dial: 0 → -90° (left), 100 → +90° (right).
 * Returned rather than drawn so the page (SVG) and the email (a segmented bar,
 * because Gmail strips inline SVG) derive from one function.
 */
export function needleAngle(score: number): number {
  return (clampScore(score) / 100) * 180 - 90;
}

/** Fraction along the dial, for the email's bar marker. */
export function needleFraction(score: number): number {
  return clampScore(score) / 100;
}

export type RiskDriver = {
  label: string;
  detail: string;
  /** Higher means it pushed the score up more. Used only for ordering. */
  weight: number;
  /**
   * A "caveat" is a limit on what the figures can support, not a driver of the
   * score. It carries a low weight so it never leads the list — but callers that
   * trim for space MUST keep it: dropping "we could not measure this" to make
   * room is how a report starts overstating its own confidence.
   */
  kind: "driver" | "caveat";
};

export type HoldingLike = {
  symbol: string;
  weightPct?: number;
  beta?: number;
  sector?: string;
  correlation?: { avgCorr: number | null; peers?: string[]; computable?: boolean } | null;
};

export type ExplainInput = {
  riskScore: number;
  portfolioBeta?: number;
  holdingCount?: number;
  sectorBreakdown?: Array<{ sector: string; pct?: number; weightPct?: number }>;
  holdings?: HoldingLike[];
};

/**
 * WHY the score is what it is, in the user's terms.
 *
 * Deliberately derived from the SAME stored figures the page already shows, not
 * from a second calculation or an LLM: an explanation that can drift from the
 * number it explains is worse than no explanation. Anything the data cannot
 * support is simply not claimed.
 */
export function explainPortfolioRisk(input: ExplainInput): RiskDriver[] {
  const drivers: RiskDriver[] = [];
  const holdings = input.holdings ?? [];

  const top = [...holdings].sort((a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0))[0];
  if (top && (top.weightPct ?? 0) > 0) {
    const pct = (top.weightPct ?? 0) * 100;
    drivers.push({
      label: "Largest position",
      detail: `${top.symbol} is ${pct.toFixed(1)}% of the portfolio.`
        + (pct >= 25 ? " A quarter or more in one name means its moves dominate your result." : ""),
      weight: pct,
      kind: "driver",
    });
  }

  const sectors = (input.sectorBreakdown ?? []).map((s) => ({
    sector: s.sector,
    pct: (s.pct ?? s.weightPct ?? 0) * (((s.pct ?? s.weightPct ?? 0) <= 1) ? 100 : 1),
  })).sort((a, b) => b.pct - a.pct);
  if (sectors.length && sectors[0].pct > 0) {
    drivers.push({
      label: "Sector concentration",
      detail: `${sectors[0].sector} is ${sectors[0].pct.toFixed(1)}% of the portfolio.`
        + (sectors.length === 1 ? " Everything you hold sits in one sector." : ""),
      weight: sectors[0].pct,
      kind: "driver",
    });
  }

  const beta = input.portfolioBeta;
  if (typeof beta === "number" && Number.isFinite(beta)) {
    const movePct = Math.abs(beta - 1) * 100;
    drivers.push({
      label: "Market sensitivity",
      detail: beta >= 1
        ? `Beta ${beta.toFixed(2)} — the portfolio tends to move about ${movePct.toFixed(0)}% MORE than the market.`
        : `Beta ${beta.toFixed(2)} — the portfolio tends to move about ${movePct.toFixed(0)}% LESS than the market.`,
      weight: Math.abs(beta - 1) * 40,
      kind: "driver",
    });
  }

  const clustered = holdings.filter(
    (h) => h.correlation?.computable !== false && (h.correlation?.peers?.length ?? 0) > 0,
  );
  if (clustered.length) {
    drivers.push({
      label: "Positions that move together",
      detail: `${clustered.length} of your holdings are closely correlated with another one you hold`
        + ` (${clustered.slice(0, 3).map((h) => h.symbol).join(", ")}${clustered.length > 3 ? "…" : ""}).`
        + " They are less diversifying than their count suggests.",
      weight: clustered.length * 8,
      kind: "driver",
    });
  }

  // Missing evidence is stated as missing. Silence here would read as "nothing
  // correlated", which is a claim the data does not support.
  const unknown = holdings.filter((h) => h.correlation?.computable === false);
  if (unknown.length) {
    drivers.push({
      label: "Not enough history",
      detail: `No usable price history for ${unknown.map((h) => h.symbol).join(", ")},`
        + " so their correlation is unknown rather than zero — the true clustering could be higher.",
      weight: 1,
      kind: "caveat",
    });
  }

  if ((input.holdingCount ?? holdings.length) > 0 && (input.holdingCount ?? holdings.length) <= 3) {
    drivers.push({
      label: "Few positions",
      detail: `Only ${input.holdingCount ?? holdings.length} holdings, so single-name risk is high by construction.`,
      weight: 30,
      kind: "driver",
    });
  }

  return drivers.sort((a, b) => b.weight - a.weight);
}

/** One-line summary used as the email subject and the page's headline. */
export function riskHeadline(score: number, currency: string, var95: number): string {
  const band = bandFor(score);
  const loss = `${currency}${Math.round(Math.abs(var95)).toLocaleString()}`;
  return `${band} risk (${Math.round(clampScore(score))}/100) · a bad day is around ${loss}`;
}
