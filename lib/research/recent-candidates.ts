import { getMarketDayStatus } from "@/lib/trading/market-calendar";
import { isLeveragedInverseEtf } from "@/lib/trading/symbol-policy";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import type { RecentQualifiedCandidate } from "@/types";

export const RECENT_CANDIDATE_SESSIONS = 5;
export const RECENT_CANDIDATE_CAP = 20;
export const RECENT_REFRESH_CAP = 5;

/** Retention includes the original regular session. Unknown calendars fail closed. */
export function candidateExpirySession(market: "us" | "india", firstSession: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstSession)) throw new Error("Invalid candidate session");
  const cursor = new Date(`${firstSession}T12:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || cursor.toISOString().slice(0, 10) !== firstSession
    || getMarketDayStatus(market, cursor).kind !== "trading_day") throw new Error("Candidate requires a supported regular session");
  let remaining = RECENT_CANDIDATE_SESSIONS - 1;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = getMarketDayStatus(market, cursor);
    if (!day.calendarSupported || day.kind === "special_session") throw new Error("Candidate expiry requires a supported regular-session calendar");
    if (day.kind === "trading_day") remaining--;
  }
  return cursor.toISOString().slice(0, 10);
}

export function canRetainCandidate(symbol: string, assetClass: string | undefined): boolean {
  return assetClass !== "crypto" && !symbol.endsWith("-USD")
    && !isLeveragedInverseEtf(symbol);
}

export async function recordRecentCandidate(svc: any, args: {
  signalId: string; symbol: string; market: "us" | "india"; assetClass?: string;
  eligible: boolean; source: string | undefined; now?: Date;
}): Promise<void> {
  if (!canRetainCandidate(args.symbol, args.assetClass)) return;
  const issueKey = `recent-candidates:${args.market}:writer`;
  try {
    const session = getMarketDayStatus(args.market, args.now ?? new Date());
    // Closed-day staging is never an admission, update, or invalidation.
    if (session.kind !== "trading_day") return;
    const expiry = candidateExpirySession(args.market, session.localYmd);
    const { error } = await svc.rpc("record_recent_qualified_candidate", {
      p_signal_id: args.signalId, p_eligible: args.eligible,
      p_session: session.localYmd, p_expiry: expiry, p_source: args.source ?? null,
    });
    if (error) throw new Error(error.message);
    await resolveIssue(issueKey, svc);
  } catch (error) {
    await reportIssue({ issueKey, severity: "warn", category: "data",
      title: `${args.market.toUpperCase()} candidate shortlist could not update`,
      detail: error instanceof Error ? error.message : "Shortlist persistence failed; no stale signal was revived." }, svc).catch(() => {});
  }
}

export async function readRecentCandidates(svc: any, market: "us" | "india", now = new Date()): Promise<RecentQualifiedCandidate[]> {
  const session = getMarketDayStatus(market, now);
  if (!session.calendarSupported || session.kind === "special_session") throw new Error("Shortlist calendar unavailable");
  const { data, error } = await svc.from("recent_qualified_candidates").select("*")
    .eq("market", market).eq("state", "active").gte("expires_session", session.localYmd)
    .order("latest_score", { ascending: false }).order("first_signal_id", { ascending: true }).limit(RECENT_CANDIDATE_CAP);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Five stale names first, retaining their actual discovery provenance. */
export async function recentCandidatesForResearch(svc: any, market: "us" | "india", now = new Date()): Promise<RecentQualifiedCandidate[]> {
  const issueKey = `recent-candidates:${market}:reader`;
  try {
    const session = getMarketDayStatus(market, now);
    const rows = await readRecentCandidates(svc, market, now);
    await resolveIssue(issueKey, svc);
    return rows.filter(row => row.latest_session < session.localYmd)
      .sort((a, b) => a.latest_session.localeCompare(b.latest_session) || b.latest_score - a.latest_score
        || a.symbol.localeCompare(b.symbol)).slice(0, RECENT_REFRESH_CAP);
  } catch (error) {
    await reportIssue({ issueKey, severity: "warn", category: "data", title: `${market.toUpperCase()} candidate reconsideration unavailable`,
      detail: error instanceof Error ? error.message : "Candidate shortlist read failed" }, svc).catch(() => {});
    return [];
  }
}
