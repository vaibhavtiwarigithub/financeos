import { describe, expect, it, vi } from "vitest";
import { producerOutcomeFromResponse, runWithProducerHealth } from "@/lib/shadows/producer-runs";

function fakeClient() {
  const inserts: any[] = [];
  const updates: any[] = [];
  const client = {
    from: () => ({
      insert: (row: any) => {
        inserts.push(row);
        return { select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }) };
      },
      update: (row: any) => {
        updates.push(row);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  return { client, inserts, updates };
}

describe("Upgrade Path producer run health", () => {
  it("records a successful label collector as collection only, not P&L attribution", async () => {
    const outcome = await producerOutcomeFromResponse(new Response(JSON.stringify({
      ok: true, persisted: true, asOfDate: "2026-09-27", observedSession: "2026-09-26", results: [{ status: "insufficient" }],
    }), { status: 200 }), "decision_label_metrics");
    expect(outcome).toMatchObject({
      status: "collected", observedSession: "2026-09-26",
      details: { evidenceType: "decision_label_metrics", asOfDate: "2026-09-27", persisted: true, resultCount: 1, performanceAttribution: "not_produced_by_this_collector" },
    });
  });

  it("keeps empty and failed collector responses blocked or errored", async () => {
    await expect(producerOutcomeFromResponse(new Response(JSON.stringify({ ok: true, results: [] })), "labels"))
      .resolves.toMatchObject({ status: "blocked", blockers: [expect.stringContaining("without producing")] });
    await expect(producerOutcomeFromResponse(new Response(JSON.stringify({ error: "provider unavailable" }), { status: 503 }), "bars"))
      .resolves.toMatchObject({ status: "error", blockers: ["provider unavailable"] });
  });

  it("does not call result rows collected unless the response confirms persistence", async () => {
    await expect(producerOutcomeFromResponse(new Response(JSON.stringify({
      ok: true, results: [{ status: "insufficient" }],
    }), { status: 200 }), "decision_label_metrics"))
      .resolves.toMatchObject({ status: "blocked", blockers: [expect.stringContaining("did not confirm persistence")] });
    await expect(producerOutcomeFromResponse(new Response(JSON.stringify({
      ok: true, persisted: false, results: [{ status: "complete" }],
    }), { status: 200 }), "decision_label_metrics"))
      .resolves.toMatchObject({ status: "blocked", blockers: [expect.stringContaining("did not confirm persistence")] });
  });

  it("does not report HTTP-200 partial/invalid payloads as healthy collection", async () => {
    await expect(producerOutcomeFromResponse(new Response(JSON.stringify({
      success: false, results: [{ status: "complete" }], errors: [{ symbol: "XYZ", error: "quota exhausted" }],
    }), { status: 200 }), "corporate_actions"))
      .resolves.toMatchObject({ status: "blocked", blockers: [expect.stringContaining("quota exhausted")] });
    await expect(producerOutcomeFromResponse(new Response(JSON.stringify({
      ok: true, results: [{ status: "stale", reason: "original fetch is too old" }],
    }), { status: 200 }), "prices"))
      .resolves.toMatchObject({ status: "blocked", blockers: ["stale: original fetch is too old"] });
  });

  it("treats explicit per-result fetch failures as errors", async () => {
    await expect(producerOutcomeFromResponse(new Response(JSON.stringify({
      ok: true, results: [{ status: "error", error: "source unavailable" }],
    }), { status: 200 }), "prices"))
      .resolves.toMatchObject({ status: "error", blockers: ["error: source unavailable"] });
  });

  it("records a collected run without implying that a performance result is measured", async () => {
    const { client, inserts, updates } = fakeClient();
    const value = await runWithProducerHealth({
      client, programId: "international-allocation", market: "us",
      triggerSource: "cron_authenticated", codeVersion: "abc123",
      work: async () => ({
        value: { attribution: "collecting" },
        outcome: { status: "collected", expectedSession: "2026-09-25", observedSession: "2026-09-25", details: { attribution: "collecting" } },
      }),
    });
    expect(value).toEqual({ attribution: "collecting" });
    expect(inserts[0]).toMatchObject({ program_id: "international-allocation", market: "us", status: "running" });
    expect(updates[0]).toMatchObject({ status: "collected", expected_session: "2026-09-25", observed_session: "2026-09-25" });
    expect(updates[0].finished_at).toBeTruthy();
  });

  it("persists blocked and thrown outcomes rather than hiding them", async () => {
    const blocked = fakeClient();
    await runWithProducerHealth({
      client: blocked.client, programId: "atr-exit-stop", market: "india",
      triggerSource: "owner_manual", codeVersion: null,
      work: async () => ({ value: "blocked", outcome: { status: "blocked", blockers: ["Corporate-action completeness is unverified."] } }),
    });
    expect(blocked.updates[0]).toMatchObject({ status: "blocked", blockers: ["Corporate-action completeness is unverified."] });

    const failed = fakeClient();
    await expect(runWithProducerHealth({
      client: failed.client, programId: "atr-exit-stop", market: "us",
      triggerSource: "cron_authenticated", codeVersion: null,
      work: async () => { throw new Error("raw bars unavailable"); },
    })).rejects.toThrow("raw bars unavailable");
    expect(failed.updates[0]).toMatchObject({ status: "error", blockers: ["raw bars unavailable"] });
  });
});
