export type DiscoveryProvenanceItem = {
  label: string;
  value: string;
};

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} z`;
}

/** Presentation-only candidate-admission facts. No scorer imports this module. */
export function discoveryProvenanceItems(
  source: string | null | undefined,
  raw: unknown,
): DiscoveryProvenanceItem[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const context = raw as Record<string, unknown>;
  if (source !== "edge_relative_strength") return [];

  const items: DiscoveryProvenanceItem[] = [];
  const relativeStrength = finite(context.relative_strength_z);
  const highProximity = finite(context.high_52w_proximity_z);
  const volumeBreakout = finite(context.volume_breakout_z);
  const composite = finite(context.composite);
  const evidenceDate = typeof context.edge_date === "string" ? context.edge_date : null;

  if (relativeStrength != null) items.push({ label: "6m relative strength", value: signed(relativeStrength) });
  if (highProximity != null) items.push({ label: "52-week-high proximity", value: signed(highProximity) });
  if (volumeBreakout != null) items.push({ label: "Volume breakout", value: signed(volumeBreakout) });
  if (composite != null) items.push({ label: "Admission composite", value: composite.toFixed(2) });
  if (evidenceDate) items.push({ label: "Completed session", value: evidenceDate });
  return items;
}

export function discoverySelectionReason(
  source: string | null | undefined,
  isHeld: boolean,
): string {
  if (isHeld) return "Existing holding reassessed as part of portfolio monitoring.";
  if (source === "edge_relative_strength") {
    return "Admitted from a fresh completed-session relative-strength screen. The measurements below explain admission only; they were not added to the score.";
  }
  if (source) return `Entered research from ${source.replaceAll("_", " ")}.`;
  return "Research provenance was not recorded for this historical observation.";
}
