import { NextResponse } from "next/server";
import { reportIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";

// Congressional (US House) trade disclosures.
//
// STATUS: DISCONTINUED — this capability has no upstream. It is not broken; it
// is gone. The route returns an explicit `discontinued` state and never fetches.
//
// ── Why ────────────────────────────────────────────────────────────────────
// It was served by the House Stock Watcher public S3 dataset
// (house-stock-watcher-data.s3-us-east-2.amazonaws.com/data/all_transactions.json).
// Verified dead 2026-07-16:
//   us-east-2 -> HTTP 301 <Code>PermanentRedirect</Code> naming us-west-2
//   us-west-2 -> HTTP 403 <Code>AccessDenied</Code>  (bucket no longer public)
// The upstream project is unmaintained and the bucket was taken private. Its
// sibling Senate Stock Watcher dataset returns 403 too — the project is gone,
// so there is no URL fix and no "wait for it to come back".
//
// ── Why no replacement (spike, 2026-07-16) ─────────────────────────────────
//   * lambdafin.com/api/congressional/recent — HTTP 200 with real, fresh House
//     data (no auth, no observed rate limit). DISQUALIFIED ON LICENCE, not on
//     availability: its Terms of Service forbid precisely this use — "Engage in
//     any automated use of the system, such as using scripts ... or using any
//     data mining, robots, or similar data gathering and extraction tools" and
//     grant content "for your personal, non-commercial use or internal business
//     purpose only". robots.txt additionally sets Content-Signal ai-train=no and
//     Disallow: / for ClaudeBot. It also re-serves Financial Modeling Prep data
//     (FMP_API provenance leaks into its own pages), so it is a paid vendor's
//     data at second hand.
//   * Finnhub / FMP congressional endpoints — paid tier. Violates free-cloud-only.
//   * The official House clerk feed (disclosures-clerk.house.gov .../2026FD.ZIP)
//     is HTTP 200 but carries filing METADATA only — member, filing type, docID.
//     No ticker, no amount, no side. The actual trades are one PDF per filing
//     (many scanned images), i.e. an OCR pipeline. Out of scope by owner decision.
//
// ── Why it does not retry ──────────────────────────────────────────────────
// Re-fetching a source we have characterised as permanently gone would spend
// latency on every page load to re-derive the same 403, and would render as a
// transient "temporarily unavailable" — a lie about a permanent condition. The
// gap is instead disclosed in the UI and reported once into System Health, so it
// stays visible rather than degrading into an empty box that is indistinguishable
// from "no congressional trades were disclosed this month". Those mean opposite
// things.
//
// If a licence-clean free source is ever verified, restore the fetch here and
// give a failure the loud path (reportIssue + a non-empty `status`) — never a
// silent `catch {}` back to [].

const SOURCE = "house-stock-watcher (S3 public dataset)";
const ISSUE_KEY = "markets-congress-source:discontinued";

/** Human-readable what / why / next. Rendered by the UI and sent to System Health. */
const REASON = "upstream discontinued";
const DETAIL =
  `Congressional trade disclosures are unavailable: the ${SOURCE} feed that backed this panel was taken ` +
  `private (us-east-2 -> HTTP 301 PermanentRedirect, us-west-2 -> HTTP 403 AccessDenied, verified 2026-07-16) ` +
  `and the project is unmaintained. No free, licence-clean replacement qualified: Lambda Finance serves the ` +
  `data but its Terms of Service forbid automated access; Finnhub and FMP put it behind a paid tier; the ` +
  `official House clerk feed publishes filing metadata only, with the trades locked in per-filing scanned ` +
  `PDFs. Next: this panel stays off until a licence-clean free source exists. Corporate-insider (SEC Form 4) ` +
  `data on the Insiders tab is unaffected.`;

// Report at most once an hour per warm instance. The alert itself is deduped by
// issue_key in `agent_alerts`, so this only trims redundant round-trips on a
// display route that can be hit on every page load.
const REPORT_EVERY_MS = 60 * 60 * 1000;
let lastReportedAt = 0;

export async function GET() {
  const now = Date.now();
  if (now - lastReportedAt >= REPORT_EVERY_MS) {
    lastReportedAt = now;
    // reportIssue never throws — a health-reporting failure must not break the
    // response. It is deliberately awaited: fire-and-forget can be killed when
    // the serverless invocation freezes.
    await reportIssue({
      issueKey: ISSUE_KEY,
      severity: "warn",
      category: "market-data",
      title: "Congressional trades panel has no upstream (discontinued)",
      detail: DETAIL,
    });
  }

  return NextResponse.json({
    // Kept for shape stability: the UI merges this with the SEC Form 4 rows.
    trades: [],
    status: "discontinued" as const,
    // `false` is load-bearing: this is permanent, so the UI must not offer a
    // retry. Distinguishes "unavailable" from "no trades to show".
    retryable: false,
    source: SOURCE,
    reason: REASON,
    detail: DETAIL,
    as_of: new Date().toISOString(),
  });
}
