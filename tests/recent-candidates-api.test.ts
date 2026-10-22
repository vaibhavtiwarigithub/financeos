import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/research/recent-candidates", () => ({ readRecentCandidates: vi.fn() }));
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { readRecentCandidates } from "@/lib/research/recent-candidates";
import { GET } from "@/app/api/portfolio/recent-candidates/route";

const candidate = { id: "episode", symbol: "AMD", market: "us" as const, first_signal_id: "first", latest_signal_id: "latest",
  first_score: 80, latest_score: 72, first_session: "2026-10-19", latest_session: "2026-10-21", expires_session: "2026-10-23",
  latest_at: "2026-10-21T15:00:00Z", discovery_source: "manual", state: "active" as const, refresh_lease_until: null };

describe("owner shortlist API", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(requireOwner).mockResolvedValue(null); vi.mocked(readRecentCandidates).mockResolvedValue([candidate]); });
  function service(data: Record<string, any[]>) {
    return { from: vi.fn((table: string) => {
      const q: any = {};
      for (const method of ["select", "eq", "gt", "in", "gte", "order", "or"]) q[method] = vi.fn(() => q);
      q.range = vi.fn().mockResolvedValue({ data: data[table] ?? [], error: null });
      q.then = (resolve: any) => Promise.resolve({ data: data[table] ?? [], error: null }).then(resolve);
      return q;
    }) };
  }
  it("denies a non-owner before privileged reads", async () => {
    vi.mocked(requireOwner).mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    expect((await GET(new NextRequest("https://example.test/api?market=us&book=paper"))).status).toBe(403);
    expect(createServiceClient).not.toHaveBeenCalled();
  });
  it("rejects invalid markets/books", async () => {
    expect((await GET(new NextRequest("https://example.test/api?market=crypto&book=paper"))).status).toBe(400);
  });
  it("keeps intermediate execution attempts after a later research refresh", async () => {
    const svc = service({ agent_signals: [{ id: "first", created_at: "2026-10-19T14:00:00Z" }],
      pipeline_stage_events: [
        { id: 3, symbol: "AMD", stage: "analyst", reason: "Research only", created_at: "2026-10-21T15:00:00Z" },
        { id: 2, symbol: "AMD", signal_id: "intermediate", stage: "portfolio_constructor", reason: "cash unavailable", outcome: "rejected", created_at: "2026-10-20T15:00:00Z" },
        { id: 1, symbol: "AMD", stage: "execution", reason: "Before admission", created_at: "2026-10-19T12:00:00Z" },
      ] });
    vi.mocked(createServiceClient).mockReturnValue(svc as any);
    const response = await GET(new NextRequest("https://example.test/api?market=us&book=paper"));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.candidates[0].last_decision.reason).toBe("cash unavailable");
    expect(result.candidates[0].latest_score).toBe(72);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("surfaces missing admission evidence rather than claiming no attempts", async () => {
    vi.mocked(createServiceClient).mockReturnValue(service({}) as any);
    expect((await GET(new NextRequest("https://example.test/api?market=us&book=paper"))).status).toBe(500);
  });
});
