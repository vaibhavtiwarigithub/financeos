import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/agents/llm-council/evaluate/route";
import { GET as P1_GET, POST as P1_POST } from "@/app/api/agents/evaluation/p1-gate/cron/route";

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

  it("keeps the informational P1 gate cron reachable and authenticated", async () => {
    expect(P1_GET).toBe(P1_POST);
    const response = await P1_GET(new NextRequest("https://example.test/api/agents/evaluation/p1-gate/cron", {
      method: "GET",
      headers: { authorization: "Bearer definitely-not-the-cron-secret" },
    }));
    expect(response.status).toBe(401);
  });
});
