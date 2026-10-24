import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { GET, POST } from "@/app/api/agents/llm-council/evaluate/route";

describe("LLM council evaluator cron contract", () => {
  it("serves Vercel's GET cron with the same guarded handler as POST", async () => {
    expect(GET).toBe(POST);
    const req = new NextRequest("https://example.test/api/agents/llm-council/evaluate", {
      method: "GET",
      headers: { authorization: "Bearer definitely-not-the-cron-secret" },
    });
    const response = await GET(req);
    expect(response.status).toBe(401);
  });

  it("does not schedule the obsolete pre-P1 readiness gate", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(config.crons.some((cron: { path: string }) => cron.path === "/api/agents/evaluation/p1-gate/cron")).toBe(false);
  });

  it("avoids weekend full-history evaluation under the owner-selected Free profile", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(config.crons.find((cron: { path: string }) => cron.path === "/api/agents/llm-council/evaluate").schedule).toBe("30 23 * * 1-5");
  });
});
