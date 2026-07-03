import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// DISABLED — paper trading is handled exclusively by /api/agents/paper-trade (Next.js).
// This Edge Function was disabled because:
// 1. It had a hardcoded CRON_SECRET literal (security violation).
// 2. Its DB writes (entry_price, quantity, trade_id) conflicted with migrations 003/034
//    which use fill_price, qty, paper_trade_id.
// 3. Two independent paper-trading runtimes cannot share a consistent audit ledger.
// Do not re-enable without: rotating secrets, aligning to the canonical schema,
// and consolidating to one runtime.

serve(async (_req) => {
  return new Response(
    JSON.stringify({
      disabled: true,
      reason: "Paper trading consolidated to Next.js /api/agents/paper-trade. This Edge Function is decommissioned.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  );
});
