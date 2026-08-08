import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";

export const PROPERTY_IMPORT_TYPES = ["tax_notice", "insurance_quote"] as const;
export type PropertyEvidenceImportType = (typeof PROPERTY_IMPORT_TYPES)[number];

export type PropertyEvidenceImportInput = {
  importType: PropertyEvidenceImportType;
  sourceLabel: string;
  content: string;
  market: PropertyMarketId | null;
  asOf: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parsePropertyEvidenceImport(body: unknown): PropertyEvidenceImportInput | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  const importType = candidate.importType;
  const sourceLabel = typeof candidate.sourceLabel === "string" ? candidate.sourceLabel.trim() : "";
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  const market = candidate.market === null || candidate.market === undefined ? null : candidate.market;
  const asOf = candidate.asOf === null || candidate.asOf === undefined || candidate.asOf === "" ? null : candidate.asOf;

  if (!PROPERTY_IMPORT_TYPES.includes(importType as PropertyEvidenceImportType)) return null;
  if (sourceLabel.length < 1 || sourceLabel.length > 120 || !content || new TextEncoder().encode(content).byteLength > 1_000_000) return null;
  if (market !== null && !PROPERTY_MARKETS.some((item) => item.id === market)) return null;
  if (asOf !== null && (typeof asOf !== "string" || !isIsoCalendarDate(asOf))) return null;

  return { importType: importType as PropertyEvidenceImportType, sourceLabel, content, market: market as PropertyMarketId | null, asOf: asOf as string | null };
}
