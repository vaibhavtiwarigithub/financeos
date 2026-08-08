export const PROPERTY_CHART_WINDOWS = [
  { id: "1m", label: "1M" },
  { id: "6m", label: "6M" },
  { id: "ytd", label: "YTD" },
  { id: "1y", label: "1Y" },
  { id: "5y", label: "5Y" },
  { id: "10y", label: "10Y" },
  { id: "20y", label: "20Y" },
  { id: "all", label: "All" },
] as const;

export type PropertyChartWindowId = (typeof PROPERTY_CHART_WINDOWS)[number]["id"];

export function propertyWindowCutoff(id: PropertyChartWindowId, now = new Date()): string | null {
  if (id === "all") return null;
  if (id === "ytd") return `${now.getUTCFullYear()}-01-01`;
  const months = id === "1m" ? 1 : id === "6m" ? 6 : id === "1y" ? 12 : id === "5y" ? 60 : id === "10y" ? 120 : 240;
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return cutoff.toISOString().slice(0, 10);
}
