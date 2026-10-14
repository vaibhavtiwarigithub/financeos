import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the Paper Portfolio Trades tab behavior the owner asked for: every column sortable, sold date visible, and sold positions loaded
// and surfaced (they used to sink below newer open lots and, past 50 newer lots, vanish).
const page = readFileSync("components/dashboard/PortfolioPage.tsx", "utf8");
const server = readFileSync("app/dashboard/portfolio/page.tsx", "utf8");
const table = readFileSync("lib/paper-trades-table.ts", "utf8");

describe("Paper Portfolio trades tab", () => {
  it("renders every column header as a sort control with aria-sort", () => {
    expect(page).toContain("TRADE_COLUMNS.map((c, index)");
    expect(page).toContain("aria-sort=");
    expect(page).toContain("setTradeSort(nextSort(tradeSort, c.key))");
  });
  it("shows when a lot was sold and why, and filters open vs sold", () => {
    expect(table).toContain('label: "Sold"');
    expect(table).toContain('label: "Exit reason"');
    expect(page).toContain("setTradeStatus(value)");
    expect(page).toContain('data-testid="paper-recent-sales"');
  });
  it("defaults to latest activity so a fresh sale is not buried under older open lots", () => {
    expect(page).toContain('useState<{ key: TradeSortKey; dir: SortDir }>({ key: "activity", dir: "desc" })');
  });
  it("loads the newest sales as well as the newest entries", () => {
    expect(server).toContain('.not("closed_at", "is", null).order("closed_at", { ascending: false })');
    expect(server).toContain("tradeById");
  });
  it("keeps the table client-bundle safe: the helper imports nothing", () => {
    expect([...table.matchAll(/^import /gm)]).toHaveLength(0);
  });
});
