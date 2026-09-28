import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  cron: vi.fn(() => true),
  owner: vi.fn(async () => null as unknown),
  run: vi.fn(),
  health: vi.fn(),
}));

vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: h.cron }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: h.owner }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/shadows/atr-forward-run", () => ({ runAtrForwardCollection: h.run }));
vi.mock("@/lib/shadows/producer-runs", () => ({
  runWithProducerHealth: async (input: any) => {
    const result = await input.work();
    h.health(input, result.outcome);
    return result.value;
  },
}));

import { POST } from "@/app/api/agents/atr-stop-forward/route";

const req = (market?: string) => new NextRequest(`http://localhost/api/agents/atr-stop-forward${market ? `?market=${market}` : ""}`, { method: "POST" });

beforeEach(() => {
  h.cron.mockReset().mockReturnValue(true);
  h.owner.mockReset().mockResolvedValue(null);
  h.run.mockReset();
  h.health.mockReset();
});

describe("POST /api/agents/atr-stop-forward", () => {
  it("refuses India: no corporate-action source exists, so its replay must stay blocked", async () => {
    const res = await POST(req("india"));
    expect(res.status).toBe(400);
    expect((await res.json()).persisted).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.health).not.toHaveBeenCalled();
  });

  it("refuses a missing market rather than defaulting to one", async () => {
    expect((await POST(req())).status).toBe(400);
  });

  it("refuses an unauthenticated caller before doing any work", async () => {
    h.cron.mockReturnValue(false);
    h.owner.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const res = await POST(req("us"));
    expect(res.status).toBe(401);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("records a blocked run as blocked and never as collected", async () => {
    h.run.mockResolvedValue({ status: "blocked", blockers: ["Session 2026-09-28 refused: no bar"], expectedSession: "2026-09-28", observedSession: "2026-09-25", written: [], details: { mode: "step" } });
    const res = await POST(req("us"));
    expect(res.status).toBe(200);
    expect((await res.json()).persisted).toBe(false);
    const outcome = h.health.mock.calls[0][1];
    expect(outcome).toMatchObject({ status: "blocked", expectedSession: "2026-09-28", observedSession: "2026-09-25" });
    expect(outcome.blockers[0]).toContain("refused");
    expect(outcome.details.performanceAttribution).toBe("not_produced_by_this_collector");
  });

  it("records a collected run with what it wrote", async () => {
    h.run.mockResolvedValue({ status: "collected", blockers: [], expectedSession: "2026-09-28", observedSession: "2026-09-28", written: ["2026-09-28"], details: { mode: "step", advanced: 1 } });
    const res = await POST(req("us"));
    expect((await res.json()).persisted).toBe(true);
    expect(h.health.mock.calls[0][1]).toMatchObject({ status: "collected", details: { written: ["2026-09-28"], evidenceType: "forward_paired_book_snapshot" } });
    expect(h.health.mock.calls[0][0]).toMatchObject({ programId: "exit-stop-shadow", market: "us", triggerSource: "cron_authenticated" });
  });
});
