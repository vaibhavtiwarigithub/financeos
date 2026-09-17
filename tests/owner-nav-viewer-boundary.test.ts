import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const shell = readFileSync(resolve(root, "components/dashboard/DashboardShell.tsx"), "utf8");
const userSettings = readFileSync(resolve(root, "app/dashboard/user-settings/page.tsx"), "utf8");

describe("viewer-owned broker navigation stays out of the owner shell", () => {
  it("marks private connections and risk links as viewer-only", () => {
    const myRisk = shell.slice(shell.indexOf('href: "/dashboard/my-risk"'), shell.indexOf('href: "/dashboard/my-risk"') + 300);
    const preferences = shell.slice(shell.indexOf('href: "/dashboard/user-settings"'), shell.indexOf('href: "/dashboard/user-settings"') + 450);
    expect(myRisk).toContain("viewerOnly: true");
    expect(preferences).toContain("viewerOnly: true");
  });

  it("filters viewer-only items from the owner sidebar", () => {
    expect(shell).toContain("items: section.items.filter((item) => !item.viewerOnly)");
  });

  it("redirects an owner who opens the viewer preferences URL directly", () => {
    expect(userSettings).toContain('router.replace("/dashboard/settings?tab=trading")');
  });
});
