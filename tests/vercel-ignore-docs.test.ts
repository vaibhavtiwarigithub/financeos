import { describe, expect, it } from "vitest";
import { shouldSkipDocsOnlyBuild } from "../scripts/vercel-ignore-docs.mjs";

describe("Vercel docs-only build filter", () => {
  it("skips commits containing only non-runtime documentation", () => {
    expect(shouldSkipDocsOnlyBuild([
      "WORK_LOG.md",
      "features/agentic-quant-platform/ACCEPTANCE_MATRIX.md",
      "docs/arch/04-database-schema.md",
    ])).toBe(true);
  });

  it("continues deploying when any application or deployment file changes", () => {
    expect(shouldSkipDocsOnlyBuild([
      "features/agentic-quant-platform/FEATURE_ARCHITECTURE.md",
      "app/dashboard/page.tsx",
    ])).toBe(false);
    expect(shouldSkipDocsOnlyBuild(["vercel.json"])).toBe(false);
    expect(shouldSkipDocsOnlyBuild(["public/content/guide.md"])).toBe(false);
  });

  it("skips an empty diff, but not a diff with a single unknown path", () => {
    expect(shouldSkipDocsOnlyBuild([])).toBe(true);
    expect(shouldSkipDocsOnlyBuild(["README.md"])).toBe(false);
  });
});
