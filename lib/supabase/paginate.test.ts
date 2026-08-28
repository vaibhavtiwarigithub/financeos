import { describe, it, expect } from "vitest";
import { fetchAllRows, PAGE_SIZE } from "./paginate";

const rows = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: offset + i }));

describe("fetchAllRows", () => {
  // THE BUG THIS EXISTS FOR: a full page is not proof there is no more data.
  it("keeps paging while pages come back full", async () => {
    const source = rows(PAGE_SIZE * 2 + 7);
    const seen: number[] = [];
    const out = await fetchAllRows(async (from, to) => {
      seen.push(from);
      return { data: source.slice(from, to + 1), error: null };
    });
    expect(out).toHaveLength(source.length);
    expect(seen).toEqual([0, PAGE_SIZE, PAGE_SIZE * 2]);
  });

  it("stops on the first short page", async () => {
    let calls = 0;
    const out = await fetchAllRows(async () => { calls++; return { data: rows(10), error: null }; });
    expect(calls).toBe(1);
    expect(out).toHaveLength(10);
  });

  // An exactly-full final page must still trigger one more request, or the last
  // page is indistinguishable from a truncation.
  it("requests one more page when the total is an exact multiple", async () => {
    let calls = 0;
    const out = await fetchAllRows(async (from) => {
      calls++;
      return { data: from === 0 ? rows(PAGE_SIZE) : [], error: null };
    });
    expect(calls).toBe(2);
    expect(out).toHaveLength(PAGE_SIZE);
  });

  it("throws rather than returning a partial result on error", async () => {
    await expect(fetchAllRows(async () => ({ data: null, error: { message: "boom" } }), "labels"))
      .rejects.toThrow("labels failed: boom");
  });

  it("refuses to page forever", async () => {
    await expect(fetchAllRows(async () => ({ data: rows(PAGE_SIZE), error: null })))
      .rejects.toThrow(/exceeded 200 pages/);
  });
});
