import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { inspectRobinhoodMcpCapabilities } from "@/lib/robinhood-mcp";
import { assessCryptoBrokerCapability } from "@/lib/brokers/crypto-capability";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Stage A evidence collector. tools/list only: no account, pair, quote, preview,
// or order tool is called. A listed `place_crypto_order` tool never means that
// Kairos may submit an order; this route records only the contract boundary.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const supabase = createServiceClient();
  const observedAt = new Date().toISOString();
  const inspected = await inspectRobinhoodMcpCapabilities();
  const row = inspected.ok
    ? (() => {
        const capability = assessCryptoBrokerCapability(inspected.snapshot.toolNames);
        return {
          observed_at: observedAt,
          source: "robinhood_mcp_tools_list",
          status: capability.readReady ? "done" : "partial",
          summary: {
            tool_count: inspected.snapshot.toolCount,
            schema_fingerprint: inspected.snapshot.schemaFingerprint,
            // Narrow derived fact, not the raw schema (see robinhood-mcp.ts's
            // own "persist hashes, not untrusted schemas" rule) — answers
            // whether place_crypto_order advertises a stop/trigger order
            // type, the open question blocking crypto live trading (L4
            // proposal part 8). null = tool not found or schema unreadable;
            // [] = tool found, no order-type/trigger enum recognized.
            place_crypto_order_advertised_types: inspected.snapshot.placeCryptoOrderAdvertisedTypes,
            ...capability,
            // Explicitly prevent the UI/consumer from mistaking tool discovery
            // for account/pair/quote validation.
            pair_inventory_observed: false,
            account_eligibility_observed: false,
            executable_quote_observed: false,
            live_execution_enabled: false,
          },
          error: capability.readReady ? null : `missing_read_tools:${capability.missingReadTools.join(",")}`,
        };
      })()
    : {
        observed_at: observedAt,
        source: "robinhood_mcp_tools_list",
        status: "error",
        summary: { live_execution_enabled: false },
        error: `capability_probe:${inspected.errorCode}`,
      };

  const { data, error } = await supabase.from("crypto_universe_runs").insert(row).select("id").single();
  if (error) return NextResponse.json({ error: "crypto capability evidence write failed" }, { status: 500 });
  if (row.status === "done") {
    await resolveIssue("crypto-capability-probe", supabase);
  } else {
    await reportIssue({
      issueKey: "crypto-capability-probe",
      severity: row.status === "error" ? "warn" : "info",
      category: "broker",
      title: "Crypto broker capability is not ready for execution",
      detail: row.error ?? "The broker contract is incomplete. Crypto remains paper/shadow-only; no live order path is enabled.",
      autoExpireAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    }, supabase);
  }
  return NextResponse.json({ id: data?.id, observedAt, ...row });
}

export async function GET(req: NextRequest) { return POST(req); }
