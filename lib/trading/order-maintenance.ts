import { robinhoodMcpAdapter } from "@/lib/brokers/adapters/robinhood-mcp";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { isMarketSessionOpen } from "@/lib/trading/market-calendar";

// A Robinhood MCP cold start can take more than a minute. Bound each cron run
// to one write and one read so Vercel can finish deterministically.
const MAX_BROKER_CALLS_PER_RUN = 1;

// Auto-cancel broker_orders stuck in pending_submit/submitted for >30 min.
// Only acts on US market rows with a broker_order_id (can't cancel without one).
// Every broker response moves the row to reconciliation. A cancel refusal can
// mean the order filled or reached another terminal state before our request;
// repeatedly sending cancel without reading broker truth leaves it stuck forever.
export async function cancelStaleOrders(supabase: any): Promise<{ cancelled: number; errors: number }> {
  let cancelled = 0;
  let errors = 0;

  // There is nothing to cancel on a closed US session. More importantly, do not
  // wake a broker MCP session every thirty minutes through nights and weekends.
  if (!isMarketSessionOpen("us")) return { cancelled, errors };

  try {
    const { data: rows, error } = await supabase
      .from("broker_orders")
      .select("id, symbol, broker_order_id")
      .in("status", ["pending_submit", "submitted"])
      .eq("market", "us")
      .not("broker_order_id", "is", null)
      .lt("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
      .order("created_at", { ascending: true })
      .limit(MAX_BROKER_CALLS_PER_RUN);

    if (error) {
      console.error("[order-maintenance] cancelStaleOrders query failed:", error.message);
      return { cancelled: 0, errors: 1 };
    }

    if (!rows?.length) return { cancelled: 0, errors: 0 };

    const adapter = robinhoodMcpAdapter();
    for (const row of rows) {
      try {
        const r = await adapter.cancelOrder(String(row.broker_order_id), "live");
        if (r.ok) {
          // A cancel ACK is not proof of terminal state: a fill can win the race
          // with the cancel. Reconcile before ever calling the row cancelled.
          const { error: updateError } = await supabase.from("broker_orders")
            .update({ status: "unknown_needs_reconcile", error: "cancel accepted; confirmation pending" })
            .eq("id", row.id);
          if (updateError) throw new Error(`could not mark cancel for reconciliation: ${updateError.message}`);
          console.log(`[order-maintenance] cancel accepted; reconciliation pending for ${row.id} (${row.symbol})`);
          cancelled++;
        } else {
          console.error(`[order-maintenance] cancel failed for order ${row.id}: ${r.error}`);
          const { error: updateError } = await supabase.from("broker_orders")
            .update({
              status: "unknown_needs_reconcile",
              error: `cancel not confirmed; reconciliation required: ${r.error ?? "unknown cancel error"}`,
            })
            .eq("id", row.id);
          if (updateError) throw new Error(`could not mark cancel refusal for reconciliation: ${updateError.message}`);
          await reportIssue({
            issueKey: `order-cancel-failed:${row.id}`,
            severity: "warn",
            category: "trading",
            title: `Stale order ${row.symbol} could not be cancelled`,
            detail: r.error ?? "unknown cancel error",
          }, supabase);
          errors++;
        }
      } catch (e) {
        console.error(`[order-maintenance] cancelOrder threw for ${row.id}:`, String(e));
        const message = e instanceof Error ? e.message : String(e);
        const { error: updateError } = await supabase.from("broker_orders")
          .update({
            status: "unknown_needs_reconcile",
            error: `cancel outcome unknown; reconciliation required: ${message}`,
          })
          .eq("id", row.id);
        if (updateError) {
          console.error(`[order-maintenance] could not queue reconciliation for ${row.id}: ${updateError.message}`);
        }
        await reportIssue({
          issueKey: `order-cancel-failed:${row.id}`,
          severity: "warn",
          category: "trading",
          title: `Stale order ${row.symbol} cancellation outcome is unknown`,
          detail: message,
        }, supabase);
        errors++;
      }
    }
  } catch (e) {
    console.error("[order-maintenance] cancelStaleOrders failed:", String(e));
    errors++;
  }

  return { cancelled, errors };
}

// Poll Robinhood for unknown_needs_reconcile rows and update status to actual state.
// Resolves the order-needs-reconcile issue key on success.
// Never places new orders — status updates only.
export async function reconcileUnknownOrders(supabase: any): Promise<{ resolved: number; errors: number }> {
  let resolved = 0;
  let errors = 0;

  try {
    const { data: rows, error } = await supabase
      .from("broker_orders")
      .select("id, symbol, broker_order_id, proposal_id, qty")
      .eq("status", "unknown_needs_reconcile")
      .eq("market", "us")
      .not("broker_order_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(MAX_BROKER_CALLS_PER_RUN);

    if (error) {
      console.error("[order-maintenance] reconcileUnknownOrders query failed:", error.message);
      return { resolved: 0, errors: 1 };
    }

    if (!rows?.length) return { resolved: 0, errors: 0 };

    const adapter = robinhoodMcpAdapter();
    for (const row of rows) {
      try {
        const r = await adapter.getOrder(String(row.broker_order_id), "live");
        if (!r.ok || !r.status) {
          console.error(`[order-maintenance] getOrder failed for ${row.id}: ${r.error}`);
          errors++;
          continue;
        }

        // Map RH status to our broker_orders status column.
        // canceled/rejected/expired → cancelled; submitted → submitted; filled/partially_filled as-is.
        const newStatus = r.status === "canceled" || r.status === "rejected" || r.status === "expired"
          ? "cancelled"
          : r.status; // "filled" | "partially_filled" | "submitted"

        const terminal = ["filled", "cancelled"].includes(newStatus);
        const update: Record<string, any> = {
          status: newStatus,
          raw_last_state: r.raw ?? null,
          closed_at: terminal ? new Date().toISOString() : null,
        };
        if (r.filledQty != null) update.filled_qty = r.filledQty;
        if (r.avgFillPrice != null) update.avg_fill_price = r.avgFillPrice;
        const { error: updateError } = await supabase.from("broker_orders").update(update).eq("id", row.id);
        if (updateError) throw new Error(`reconciliation update failed: ${updateError.message}`);

        // The order ledger owns fill truth. Portfolio snapshots remain the
        // authoritative holdings/NAV source, but the proposal must reflect a
        // confirmed broker fill rather than remain pending forever.
        if (newStatus === "filled" && row.proposal_id) {
          const { error: proposalError } = await supabase.from("trade_proposals").update({
            status: "executed",
            fill_price: r.avgFillPrice ?? null,
            fill_qty: r.filledQty ?? row.qty,
            filled_at: new Date().toISOString(),
          }).eq("id", row.proposal_id);
          if (proposalError) throw new Error(`proposal fill update failed: ${proposalError.message}`);
        }

        await resolveIssue(`order-needs-reconcile:${row.id}`, supabase);
        await resolveIssue(`order-cancel-failed:${row.id}`, supabase);
        console.log(`[order-maintenance] reconciled order ${row.id} (${row.symbol}) → ${newStatus}`);
        resolved++;
      } catch (e) {
        console.error(`[order-maintenance] reconcile threw for ${row.id}:`, String(e));
        errors++;
      }
    }
  } catch (e) {
    console.error("[order-maintenance] reconcileUnknownOrders failed:", String(e));
    errors++;
  }

  return { resolved, errors };
}
