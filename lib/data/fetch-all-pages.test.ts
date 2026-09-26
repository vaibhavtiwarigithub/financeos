import { describe, expect, it, vi } from "vitest";
import { fetchAllPages } from "./fetch-all-pages";

describe("fetchAllPages", () => {
  it("fetches all rows in bounded pages, including an exact page boundary", async () => {
    const fetchPage = vi.fn(async (from: number, to: number) => ({
      data: from === 0 ? Array.from({ length: 2 }, (_, i) => i) : from === 2 ? [2, 3] : [],
      error: null,
    }));
    const result = await fetchAllPages(fetchPage, 2);
    expect(result).toEqual({ data: [0, 1, 2, 3], error: null });
    expect(fetchPage.mock.calls).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it("stops and returns the provider error", async () => {
    const error = { message: "query failed" };
    const result = await fetchAllPages(async () => ({ data: null, error }), 2);
    expect(result).toEqual({ data: [], error });
  });

  it("rejects an invalid page size", async () => {
    await expect(fetchAllPages(async () => ({ data: [], error: null }), 0)).rejects.toThrow("pageSize");
  });
});
