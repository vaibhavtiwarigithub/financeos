import { describe, expect, it } from "vitest";
import { SYSTEM_REFERENCE_DOCUMENTS, findSystemReferenceDocument } from "@/lib/system-reference/registry";

describe("system reference registry", () => {
  it("uses unique opaque ids and repository-relative markdown paths", () => {
    const ids = SYSTEM_REFERENCE_DOCUMENTS.map((document) => document.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const document of SYSTEM_REFERENCE_DOCUMENTS) {
      expect(document.path).toMatch(/\.md$/);
      expect(document.path).not.toContain("..");
      expect(document.path).not.toMatch(/^[A-Za-z]:/);
    }
  });

  it("does not resolve an unallowlisted document", () => {
    expect(findSystemReferenceDocument("../../.env.local")).toBeNull();
    expect(findSystemReferenceDocument("architecture")?.path).toBe("ARCHITECTURE.md");
  });
});
