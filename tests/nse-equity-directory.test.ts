import { describe, expect, it } from "vitest";
import { parseNseEquityListCsv } from "@/lib/nse-data";

function directoryCsv(count = 1_100): string {
  const rows = ["SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING"];
  for (let i = 0; i < count; i++) {
    const series = i % 4 === 0 ? "BE" : "EQ";
    rows.push(`S${String(i).padStart(4, "0")},\"Company, ${i}\",${series},01-Jan-2000`);
  }
  rows.push("EXCLUDED,Inactive Sample,BZ,01-Jan-2000");
  return rows.join("\r\n");
}

describe("parseNseEquityListCsv", () => {
  it("accepts the official header, handles quoted commas, and includes only EQ/BE", () => {
    const parsed = parseNseEquityListCsv(directoryCsv());
    expect(parsed.valid).toBe(true);
    expect(parsed.symbols).toHaveLength(1_100);
    expect(parsed.symbols).toContain("S0000.NS");
    expect(parsed.symbols).toContain("S0001.NS");
    expect(parsed.symbols).not.toContain("EXCLUDED.NS");
  });

  it("fails closed on an HTML block page or changed CSV header", () => {
    expect(parseNseEquityListCsv("<html>blocked</html>").reason).toBe("unexpected_header");
    expect(parseNseEquityListCsv("SYMBOL,COMPANY,SERIES\nA,Name,EQ").valid).toBe(false);
  });

  it("fails closed on a truncated response below the broad-market floor", () => {
    const parsed = parseNseEquityListCsv(directoryCsv(999));
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toBe("coverage_below_floor");
    expect(parsed.symbols).toEqual([]);
  });

  it("rejects excessive malformed rows rather than silently shortening discovery", () => {
    const valid = directoryCsv();
    const malformed = Array.from({ length: 12 }, (_, i) => `"broken row ${i}`).join("\n");
    const parsed = parseNseEquityListCsv(`${valid}\n${malformed}`);
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toBe("too_many_malformed_rows");
  });
});
