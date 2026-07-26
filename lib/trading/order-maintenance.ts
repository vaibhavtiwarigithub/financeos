import { robinhoodMcpAdapter } from "@/lib/brokers/adapters/robinhood-mcp";
import { reportIssue, resolveIssue } from "@/lib/system-health";

// Auto-cancel broker_orders stuck in pending_submit/submitted for >30 min.
// Only acts on US market rows with a broker_order_id (can't cancel without one).
// Updates status to 'cancelled' on success; emits a reportIssue on failure.
export async function cancelStaleOrders(supabase: any): Promise<{ cancelled: number; errors: number }> {
  let cancelled = 0;
  let errors = 0;

  try {
    const { data: rows, error } = await supabase
      .from("broker_orders")
      .select("id, symbol, broker_order_id")
      .in("status", ["pending_submit", "submitted"])
      .eq("market", "us")
      .not("broker_order_id", "is", null)
      .lt("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString());

    if (error) {
      console.error("[order-maintenance] cancelStaleOrders query failed:", error.message);
      return { cancelled: 0, errors: 1 };
    }

    if (!rows?.length) return { cancelled: 0, errors: 0 };

    const adapter = robinhoodMcpAdapter();
    for (const row of rows) {
      try {
        const r = await adapter.cancelOrder(row.broker_order_id, "live");
        if (r.ok) {
          await supabase.from("broker_orders").update({ status: "cancelled" }).eq("id", row.id);
          console.log(`[order-maintenance] cancelled stale order ${row.id} (${row.symbol})`);
          cancelled++;
        } else {
          console.error(`[order-maintenance] cancel failed for order ${row.id}: ${r.error}`);
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
      .select("id, symbol, broker_order_id")
      .eq("status", "unknown_needs_reconcile")
      .eq("market", "us")
      .not("broker_order_id", "is", null);

    if (error) {
      console.error("[order-maintenance] reconcileUnknownOrders query failed:", error.message);
      return { resolved: 0, errors: 1 };
    }

    if (!rows?.length) return { resolved: 0, errors: 0 };

    const adapter = robinhoodMcpAdapter();
    for (const row of rows) {
      try {
        const r = await adapter.getOrder(row.broker_order_id, "live");
        if (!r.ok) {
          console.error(`[order-maintenance] getOrder failed for ${row.id}: ${r.error}`);
          errors++;
          continue;
        }

        // Map RH status to our broker_orders status column.
        // canceled/rejected/expired → cancelled; submitted → submitted; filled/partially_filled as-is.
        const newStatus = r.status === "canceled" || r.status === "rejected" || r.status === "expired"
          ? "cancelled"
          : r.status; // "filled" | "partially_filled" | "submitted"

        const update: Record<string, any> = { status: newStatus };
        if (r.filledQty != null) update.qty = r.filledQty; // ponytail: reuse qty col for filled qty
        await supabase.from("broker_orders").update(update).eq("id", row.id);

        await resolveIssue(`order-needs-reconcile:${row.broker_order_id}`, supabase);
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
