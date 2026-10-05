import { expectedNewestSession } from "@/lib/data/completed-candles";
import { reportIssue, resolveIssue } from "@/lib/system-health";

type Market = "us" | "india";

export interface PaperEodRow {
  date: string;
  snapshot_type: string | null;
  nav: number | null;
  cash_balance: number | null;
  positions_value: number | null;
}

/** The monitor runs after the close; allow three hours for its scheduled run and retry. */
export function duePaperEodSession(market: Market, now: Date): string {
  return expectedNewestSession(market, new Date(now.getTime() - 3 * 60 * 60 * 1000));
}

export function paperEodDefects(row: PaperEodRow | null, markCount: number): string[] {
  if (!row) return ["canonical paper_performance row is missing"];
  const defects: string[] = [];
  if (row.snapshot_type !== "eod") defects.push(`snapshot_type=${row.snapshot_type ?? "null"}, not eod`);
  const nav = Number(row.nav);
  const cash = Number(row.cash_balance);
  const positions = Number(row.positions_value);
  if (row.nav == null || row.cash_balance == null || row.positions_value == null ||
      ![nav, cash, positions].every(Number.isFinite) || nav <= 0 || cash < 0 || positions < 0) {
    defects.push("NAV components are missing or invalid");
  } else {
    if (Math.abs(nav - cash - positions) > Math.max(0.01, nav * 0.000001)) {
      defects.push("NAV does not reconcile to cash plus position value");
    }
    if (positions > 0 && markCount < 1) defects.push("positive position value has no persisted position mark");
  }
  return defects;
}

/** Check persisted EOD evidence, not merely the PositionMonitor run status. */
export async function checkPaperEodHealth(svc: any, market: Market, now = new Date()): Promise<string[]> {
  const session = duePaperEodSession(market, now);
  const issueKey = `paper-eod-truth:${market}`;
  try {
    const [perf, marks] = await Promise.all([
      svc.from("paper_performance")
        .select("date,snapshot_type,nav,cash_balance,positions_value")
        .eq("market", market).eq("date", session).maybeSingle(),
      svc.from("paper_position_marks")
        .select("position_id", { count: "exact", head: true })
        .eq("market", market).eq("session_date", session),
    ]);
    if (perf.error || marks.error) {
      throw new Error(`EOD read failed: ${perf.error?.message ?? marks.error?.message}`);
    }
    const defects = paperEodDefects(perf.data as PaperEodRow | null, marks.count ?? 0);
    if (defects.length) {
      await reportIssue({
        issueKey, severity: "critical", category: "paper-truth",
        title: `Canonical paper EOD missing or invalid — ${market.toUpperCase()} ${session}`,
        detail: `${defects.join("; ")}. A successful agent run alone does not establish EOD NAV truth. Inspect PositionMonitor and its mark ledger; do not relabel intraday data as EOD.`,
      }, svc);
    } else {
      await resolveIssue(issueKey, svc);
    }
    return defects;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await reportIssue({
      issueKey, severity: "warn", category: "paper-truth",
      title: `Canonical paper EOD health unknown — ${market.toUpperCase()} ${session}`,
      detail,
    }, svc);
    return [detail];
  }
}
