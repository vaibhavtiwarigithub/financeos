export type ExternalResearchMarket = "us" | "india";
export type ExternalResearchCurrency = "USD" | "INR";
export type ExternalResearchArtifactKind = "hypothesis" | "critique" | "numeric_signal" | "backtest_report";

export interface ExternalResearchRelease {
  id: "vibe_deterministic";
  sourceRepo: "HKUDS/Vibe-Trading";
  sourceCommit: string;
  licenseSpdx: "MIT";
  capability: "backtest";
  networkMode: "none";
  permittedMarkets: readonly ExternalResearchMarket[];
  permittedArtifacts: readonly ExternalResearchArtifactKind[];
  enabled: false;
}

export interface ExternalResearchSnapshot {
  snapshotId: string;
  snapshotHash: string;
  market: ExternalResearchMarket;
  currency: ExternalResearchCurrency;
  asOf: string;
  symbols: readonly string[];
}

export interface ExternalResearchArtifact {
  schemaVersion: "1";
  runId: string;
  snapshotHash: string;
  integrationId: string;
  sourceCommit: string;
  market: ExternalResearchMarket;
  currency: ExternalResearchCurrency;
  asOf: string;
  status: "completed" | "abstained";
  artifactKind: ExternalResearchArtifactKind;
  coverage: { eligibleN: number; resolvedN: number };
  payload: Record<string, unknown>;
}

export type ArtifactValidation = { ok: true } | { ok: false; reason: string };

const MAX_SYMBOLS = 500;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const VIBE_DETERMINISTIC_RELEASE: ExternalResearchRelease = {
  id: "vibe_deterministic",
  sourceRepo: "HKUDS/Vibe-Trading",
  // The release remains unavailable until source pin, SBOM, and synthetic sandbox
  // review supply a real commit hash. A placeholder cannot be dispatched.
  sourceCommit: "UNREVIEWED",
  licenseSpdx: "MIT",
  capability: "backtest",
  networkMode: "none",
  permittedMarkets: ["us", "india"],
  permittedArtifacts: ["backtest_report"],
  enabled: false,
};

function hasUnsafeValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === "number") return !Number.isFinite(value);
  if (value == null || typeof value === "string" || typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.some((item) => hasUnsafeValue(item, depth + 1));
  if (typeof value !== "object") return true;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => BANNED_KEYS.has(key) || hasUnsafeValue(child, depth + 1));
}

function expectedCurrency(market: ExternalResearchMarket): ExternalResearchCurrency {
  return market === "us" ? "USD" : "INR";
}

/** Validates an artifact before any future append-only persistence gateway accepts it. */
export function validateExternalResearchArtifact(
  release: ExternalResearchRelease,
  snapshot: ExternalResearchSnapshot,
  artifact: ExternalResearchArtifact,
): ArtifactValidation {
  if (release.enabled || release.sourceCommit === "UNREVIEWED" || release.networkMode !== "none") {
    return { ok: false, reason: "release_not_admitted" };
  }
  if (snapshot.market !== artifact.market || snapshot.currency !== artifact.currency || snapshot.currency !== expectedCurrency(snapshot.market)) {
    return { ok: false, reason: "market_or_currency_mismatch" };
  }
  if (snapshot.symbols.length === 0 || snapshot.symbols.length > MAX_SYMBOLS || new Set(snapshot.symbols).size !== snapshot.symbols.length) {
    return { ok: false, reason: "invalid_snapshot_universe" };
  }
  if (artifact.snapshotHash !== snapshot.snapshotHash || artifact.integrationId !== release.id || artifact.sourceCommit !== release.sourceCommit) {
    return { ok: false, reason: "provenance_mismatch" };
  }
  if (!release.permittedMarkets.includes(artifact.market) || !release.permittedArtifacts.includes(artifact.artifactKind)) {
    return { ok: false, reason: "capability_not_allowed" };
  }
  if (!Number.isInteger(artifact.coverage.eligibleN) || !Number.isInteger(artifact.coverage.resolvedN) || artifact.coverage.eligibleN < 0 || artifact.coverage.resolvedN < 0 || artifact.coverage.resolvedN > artifact.coverage.eligibleN) {
    return { ok: false, reason: "invalid_coverage" };
  }
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(artifact.payload), "utf8"); } catch { return { ok: false, reason: "invalid_payload" }; }
  if (bytes > MAX_PAYLOAD_BYTES || hasUnsafeValue(artifact.payload)) return { ok: false, reason: "unsafe_payload" };
  return { ok: true };
}
