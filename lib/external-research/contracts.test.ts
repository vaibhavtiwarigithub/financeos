import { describe, expect, it } from "vitest";
import { validateExternalResearchArtifact, VIBE_DETERMINISTIC_RELEASE } from "./contracts";

const snapshot = { snapshotId: "s1", snapshotHash: "hash", market: "us" as const, currency: "USD" as const, asOf: "2026-08-10T00:00:00.000Z", symbols: ["AAPL"] };
const artifact = { schemaVersion: "1" as const, runId: "r1", snapshotHash: "hash", integrationId: "vibe_deterministic", sourceCommit: "UNREVIEWED", market: "us" as const, currency: "USD" as const, asOf: snapshot.asOf, status: "completed" as const, artifactKind: "backtest_report" as const, coverage: { eligibleN: 1, resolvedN: 1 }, payload: { sharpe: 0.1 } };

describe("external research artifact contract", () => {
  it("rejects every artifact until a release has been source-pinned and admitted", () => {
    expect(validateExternalResearchArtifact(VIBE_DETERMINISTIC_RELEASE, snapshot, artifact)).toEqual({ ok: false, reason: "release_not_admitted" });
  });

  it("rejects market/currency, provenance, and hostile payload mismatches", () => {
    const admitted = { ...VIBE_DETERMINISTIC_RELEASE, sourceCommit: "a".repeat(40) };
    expect(validateExternalResearchArtifact(admitted, snapshot, { ...artifact, sourceCommit: "b".repeat(40) })).toEqual({ ok: false, reason: "provenance_mismatch" });
    expect(validateExternalResearchArtifact(admitted, snapshot, { ...artifact, sourceCommit: admitted.sourceCommit, currency: "INR" })).toEqual({ ok: false, reason: "market_or_currency_mismatch" });
    expect(validateExternalResearchArtifact(admitted, snapshot, { ...artifact, sourceCommit: admitted.sourceCommit, payload: { score: Number.NaN } })).toEqual({ ok: false, reason: "unsafe_payload" });
  });
});
