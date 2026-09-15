import { describe, expect, it } from "vitest";
import { formatPaperPositionOpenedAt } from "@/lib/paper/position-opened-at";

describe("formatPaperPositionOpenedAt", () => {
  it("shows US purchases in Eastern Time", () => {
    expect(formatPaperPositionOpenedAt("2026-09-10T14:35:00.000Z", "us"))
      .toBe("Sep 10, 2026 · 10:35 AM ET");
  });

  it("shows India purchases in India Standard Time", () => {
    expect(formatPaperPositionOpenedAt("2026-09-10T14:35:00.000Z", "india"))
      .toBe("Sep 10, 2026 · 8:05 PM IST");
  });

  it("refuses missing or invalid legacy timestamps", () => {
    expect(formatPaperPositionOpenedAt(null, "us")).toBeNull();
    expect(formatPaperPositionOpenedAt("not-a-date", "india")).toBeNull();
  });
});
