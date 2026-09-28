import { describe, expect, it } from "vitest";
import { orderUniverseForRefresh } from "@/lib/india-universe";

// An alphabetical universe like NSE's EQUITY_L.csv: 26 letters x 100 names.
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const universe = letters.flatMap((l) => Array.from({ length: 100 }, (_, i) => `${l}${String(i).padStart(3, "0")}.NS`));

describe("orderUniverseForRefresh", () => {
  it("does not start every run at A: the first 600 never-scored names span the alphabet", () => {
    const first = orderUniverseForRefresh(universe, new Map(), "2026-09-28").slice(0, 600);
    const seen = new Set(first.map((s) => s[0]));
    // The old comparator returned 0 for ties, so this slice was exactly A..F.
    expect(seen.size).toBeGreaterThanOrEqual(24);
    expect(seen.has("S")).toBe(true);
    expect(seen.has("Z")).toBe(true);
  });

  it("is deterministic for a given day and walks a different slice on another day", () => {
    const a1 = orderUniverseForRefresh(universe, new Map(), "2026-09-28");
    const a2 = orderUniverseForRefresh(universe, new Map(), "2026-09-28");
    const b = orderUniverseForRefresh(universe, new Map(), "2026-09-29");
    expect(a1).toEqual(a2);
    expect(a1.slice(0, 600)).not.toEqual(b.slice(0, 600));
  });

  it("puts never-scored names before scored ones, and scored names oldest first", () => {
    const scored = new Map([["A000.NS", "2026-09-20T10:00:00Z"], ["B000.NS", "2026-09-10T10:00:00Z"], ["C000.NS", "2026-09-25T10:00:00Z"]]);
    const out = orderUniverseForRefresh(universe, scored, "2026-09-28");
    expect(out.slice(-3)).toEqual(["B000.NS", "A000.NS", "C000.NS"]);
    expect(out.slice(0, -3).every((s) => !scored.has(s))).toBe(true);
  });

  it("covers the whole list within ceil(N/600) days when each day's slice gets scored", () => {
    const scored = new Map<string, string>();
    for (let day = 0; day < 5; day++) {
      const seed = `2026-10-${String(1 + day).padStart(2, "0")}`;
      for (const s of orderUniverseForRefresh(universe, scored, seed).slice(0, 600)) scored.set(s, `${seed}T10:45:00Z`);
    }
    // 2,600 names at 600/night: everything has been scored after 5 nights.
    expect(scored.size).toBe(universe.length);
    expect(scored.has("S000.NS")).toBe(true);
  });

  it("does not mutate its input", () => {
    const copy = [...universe];
    orderUniverseForRefresh(universe, new Map(), "x");
    expect(universe).toEqual(copy);
  });
});
