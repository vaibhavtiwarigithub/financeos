import { describe, it, expect } from "vitest";
import { resolveSignalDirection } from "@/lib/signal-direction";

// Invariant under test: NO LLM output can set an executable direction.
// The LLM's direction opinion may only ever appear in the human-readable note.

const base = {
  isHeld: false,
  analystScore: 70,
  scoreThreshold: 60,
  thinEvidence: false,
  includedDimsCount: 5,
  llmDirection: "long" as string | undefined,
};

describe("resolveSignalDirection — deterministic gate", () => {
  it("LLM 'short' on a NEW candidate cannot produce short (mechanical long wins)", () => {
    const r = resolveSignalDirection({ ...base, llmDirection: "short" });
    expect(r.direction).toBe("long"); // score 70 >= 60
    expect(r.note).toContain("overridden by gate");
  });

  it("LLM 'short' on a HELD position with a healthy score cannot exit it", () => {
    const r = resolveSignalDirection({ ...base, isHeld: true, analystScore: 75, llmDirection: "short" });
    expect(r.direction).toBe("long"); // held + score above threshold → hold/long, LLM ignored
  });

  it("HELD position exits ONLY on deterministic score decay, regardless of LLM opinion", () => {
    for (const llm of ["long", "short", "neutral", undefined, "garbage"]) {
      const r = resolveSignalDirection({ ...base, isHeld: true, analystScore: 45, llmDirection: llm });
      expect(r.direction).toBe("short");
      expect(r.note).toContain("deterministic exit");
    }
  });

  it("held-position exit survives thin evidence (SELL capability locked rule)", () => {
    const r = resolveSignalDirection({ ...base, isHeld: true, analystScore: 30, thinEvidence: true, includedDimsCount: 1 });
    expect(r.direction).toBe("short"); // exit checked BEFORE thin-evidence abstention
  });

  it("thin evidence abstains NEW entries even when score clears threshold", () => {
    const r = resolveSignalDirection({ ...base, analystScore: 90, thinEvidence: true, includedDimsCount: 1 });
    expect(r.direction).toBe("neutral");
    expect(r.note).toContain("thin evidence");
  });

  it("LLM 'long' cannot open a below-threshold candidate", () => {
    const r = resolveSignalDirection({ ...base, analystScore: 50, llmDirection: "long" });
    expect(r.direction).toBe("neutral");
  });

  it("failed thesis parse does not suppress a valid entry (narrative-only failure)", () => {
    const r = resolveSignalDirection({ ...base, llmDirection: undefined });
    expect(r.direction).toBe("long");
    expect(r.note).toContain("no thesis narrative");
  });

  it("defaults threshold to 60 when mandate threshold is null", () => {
    expect(resolveSignalDirection({ ...base, scoreThreshold: null, analystScore: 60 }).direction).toBe("long");
    expect(resolveSignalDirection({ ...base, scoreThreshold: null, analystScore: 59 }).direction).toBe("neutral");
    expect(resolveSignalDirection({ ...base, scoreThreshold: null, isHeld: true, analystScore: 59 }).direction).toBe("short");
  });

  it("is a pure function of evidence inputs — same inputs, same output", () => {
    const a = resolveSignalDirection({ ...base });
    const b = resolveSignalDirection({ ...base });
    expect(a).toEqual(b);
  });
});
