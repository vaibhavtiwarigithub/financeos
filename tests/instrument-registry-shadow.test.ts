import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("instrument registry L0 boundary", () => {
  it("records a classification snapshot in research observations", () => {
    const source = read("lib/research-agent.ts");
    expect(source).toContain("persistInstrumentClassification");
    expect(source).toContain("instrument: {");
    expect(source).toContain("new_entry_allowed: false");
  });

  it("does not introduce registry reads into either execution path", () => {
    expect(read("app/api/agents/paper-trade/route.ts")).not.toContain("instrument_registry");
    expect(read("lib/trading/execute-order.ts")).not.toContain("instrument_registry");
  });

  it("exposes observed classification in the research journal only", () => {
    expect(read("app/api/agents/research-journal/route.ts")).toContain("instrument_kind: instrument?.kind");
    expect(read("components/dashboard/ResearchFunnel.tsx")).toContain("identity.instrument_kind");
  });
});
