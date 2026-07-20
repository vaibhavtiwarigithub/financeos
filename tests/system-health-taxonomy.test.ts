import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("System Health taxonomy", () => {
  it("counts actions separately from collapsed informational notices", () => {
    const card = read("components/dashboard/SystemHealthCard.tsx");
    expect(card).toContain('alert.severity !== "info"');
    expect(card).toContain("No action required");
    expect(card).toContain("operational notice");
    expect(card).toContain("showNotices");
  });

  it("does not report successful Theme Scout activity as a health issue", () => {
    const route = read("app/api/agents/theme-scout/route.ts");
    const edge = read("supabase/functions/theme-scout/index.ts");
    expect(route).not.toContain("Theme Scout: ${rows.length} stocks added");
    expect(edge).not.toContain("Theme Scout: ${newRows.length} stocks added");
  });

  it("keeps informational notices out of the daily brief's open-issues section", () => {
    const briefing = read("app/api/briefing/generate/route.ts");
    expect(briefing).toContain('.in("severity", ["critical", "error", "warn", "warning"])');
  });
});
