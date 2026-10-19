import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("Alpaca Live account visibility contract", () => {
  const refresh = read("app/api/live-account/refresh-snapshot/route.ts");
  const portfolio = read("app/api/live-portfolio/route.ts");
  const ui = read("components/dashboard/LivePortfolioPage.tsx");
  const account = read("lib/brokers/alpaca.ts");
  const migration = read("supabase/migrations/20261019142610_alpaca_live_snapshot_state.sql");

  it("captures Alpaca Live independently and persists only a complete read-only snapshot", () => {
    expect(refresh).toContain("const account = await fetchAlpacaAccount(false)");
    expect(refresh).toContain('broker: "alpaca_live"');
    expect(refresh).toContain("account_state_json: state");
    expect(refresh).toContain("previous snapshot preserved");
    expect(refresh).not.toContain("fetchAlpacaAccount(true)");
    expect(refresh).toContain("await reportIssue({ issueKey");
    expect(refresh).toContain("await resolveIssue(issueKey)");
  });

  it("keeps broker-reported state visible through the existing snapshot reader and Live Portfolio", () => {
    expect(portfolio).toContain('.from("live_account_snapshots").select("*")');
    expect(ui).toContain("s.account_state_json?.status");
    expect(ui).toContain("RESTRICTED");
    expect(migration).toContain("account_state_json jsonb");
    expect(account).toContain("typeof account.trading_blocked === \"boolean\" ? account.trading_blocked : null");
    expect(refresh).toContain("const stateComplete = account.accountStatus != null");
    expect(refresh).toContain("this is not proof of trading readiness");
  });
});
