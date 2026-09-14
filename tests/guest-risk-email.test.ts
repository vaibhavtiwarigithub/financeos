import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRiskEmailHtml, riskEmailSubject } from "@/lib/email/guest-risk-email";
import { bandFor, needleFraction, explainPortfolioRisk, clampScore, BANDS } from "@/lib/risk/risk-gauge";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SENDER = code(read("app/api/agents/user-risk-email/route.ts"));
const UNSUB = code(read("app/api/user-risk/unsubscribe/route.ts"));
const PREFS = code(read("app/api/user-risk/prefs/route.ts"));
const EMAIL = code(read("lib/email/guest-risk-email.ts"));

const base = {
  asOfDate: "2026-09-14",
  market: "india" as const,
  currency: "₹",
  riskScore: 62,
  totalValue: 480000,
  var95_dollar: 5200,
  portfolioBeta: 1.24,
  holdingCount: 6,
  sectorBreakdown: [{ sector: "Technology", pct: 0.44 }, { sector: "Energy", pct: 0.2 }],
  holdings: [
    { symbol: "RELIANCE.NS", weightPct: 0.31, beta: 1.1, sector: "Energy",
      correlation: { avgCorr: 0.72, peers: ["ONGC.NS"], computable: true } },
    { symbol: "ONGC.NS", weightPct: 0.14, beta: 1.0, sector: "Energy",
      correlation: { avgCorr: 0.72, peers: ["RELIANCE.NS"], computable: true } },
    { symbol: "OBSCURE.NS", weightPct: 0.05, beta: 1.0, sector: "Other",
      correlation: { avgCorr: null, peers: [], computable: false } },
  ],
  previousScore: 48,
  staleNote: null,
  appBaseUrl: "https://app.example.com",
  unsubscribeToken: "tok-123",
};

describe("the gauge means one thing everywhere", () => {
  it("bands cover 0-100 with no gap a score could fall into", () => {
    for (let n = 0; n <= 100; n++) expect(BANDS.some((b) => n <= b.upTo)).toBe(true);
    expect(bandFor(0)).toBe("Low");
    expect(bandFor(25)).toBe("Low");
    expect(bandFor(26)).toBe("Moderate");
    expect(bandFor(100)).toBe("High");
  });

  it("clamps rather than drawing a needle off the dial", () => {
    expect(clampScore(140)).toBe(100);
    expect(clampScore(-20)).toBe(0);
    expect(clampScore(NaN)).toBe(0);
    expect(needleFraction(140)).toBe(1);
  });

  it("the page dial and the email bar read the SAME helpers", () => {
    // If they diverged, one could say Elevated while the other said Moderate.
    expect(read("components/dashboard/RiskDial.tsx").includes('from "@/lib/risk/risk-gauge"')).toBe(true);
    expect(EMAIL.includes('from "@/lib/risk/risk-gauge"')).toBe(true);
  });
});

describe("the email renders in real mail clients", () => {
  const html = buildRiskEmailHtml(base);

  it("uses no inline SVG — Gmail strips it, leaving a blank gauge", () => {
    expect(/<svg/i.test(html)).toBe(false);
    expect(EMAIL.includes("<svg")).toBe(false);
  });

  it("is table-based, not flex or grid", () => {
    expect(html.includes("<table")).toBe(true);
    expect(/display:\s*(flex|grid)/.test(html)).toBe(false);
  });

  it("escapes values rather than interpolating them raw", () => {
    const evil = buildRiskEmailHtml({ ...base, asOfDate: '"><script>alert(1)</script>' });
    expect(evil.includes("<script>")).toBe(false);
  });
});

describe("the email says only what the data supports", () => {
  const html = buildRiskEmailHtml(base);

  it("states the score, its band, and the direction it moved", () => {
    expect(html).toContain("62");
    expect(html).toContain("Elevated risk");
    expect(html).toContain("riskier");     // 62 vs a previous 48
    expect(html).toContain("was 48");
  });

  it("does not invent a trend on a first reading", () => {
    const first = buildRiskEmailHtml({ ...base, previousScore: null });
    expect(first).toContain("nothing to compare");
    expect(first).not.toContain("riskier");
  });

  it("reports missing history as unknown, never as uncorrelated", () => {
    expect(html).toContain("OBSCURE.NS");
    expect(html).toContain("unknown rather than zero");
  });

  it("carries the not-advice line and a working unsubscribe link", () => {
    expect(html).toContain("not investment advice");
    expect(html).toContain("/api/user-risk/unsubscribe?token=tok-123");
  });

  it("shows the staleness banner when the figures are not current", () => {
    const stale = buildRiskEmailHtml({ ...base, staleNote: "Your Zerodha session expired." });
    expect(stale).toContain("These figures are not current.");
  });

  it("names the portfolio, not a recommendation, in the subject", () => {
    const subject = riskEmailSubject(base);
    expect(subject).toContain("Elevated risk");
    for (const word of ["buy", "sell", "upgrade", "downgrade", "target"]) {
      expect(subject.toLowerCase().includes(word), `subject suggests action: ${word}`).toBe(false);
    }
  });
});

describe("the drivers explain the number honestly", () => {
  it("leads with the biggest concentration, whichever kind it is", () => {
    // Technology at 44% legitimately outranks a 31% single name; the list is
    // ordered by how much each pushed the score, not by a fixed category order.
    const drivers = explainPortfolioRisk(base);
    expect(drivers[0].detail).toContain("Technology is 44.0%");
    expect(drivers.find((d) => d.label === "Largest position")?.detail).toContain("RELIANCE.NS");
  });

  it("never trims the caveat away to make room for drivers", () => {
    // Regression: the email sliced the top 4 by weight, and the caveat carries
    // the LOWEST weight by design — so the "no usable history" line, the one
    // that stops the email overclaiming, was the first thing dropped.
    const crowded = buildRiskEmailHtml({
      ...base,
      holdings: [
        ...(base.holdings ?? []),
        { symbol: "X1.NS", weightPct: 0.2, beta: 1.4, sector: "Tech",
          correlation: { avgCorr: 0.8, peers: ["X2.NS"], computable: true } },
        { symbol: "X2.NS", weightPct: 0.2, beta: 1.4, sector: "Tech",
          correlation: { avgCorr: 0.8, peers: ["X1.NS"], computable: true } },
      ],
    });
    expect(crowded).toContain("unknown rather than zero");
    expect(crowded).toContain("OBSCURE.NS");
  });

  it("calls out positions that move together", () => {
    const d = explainPortfolioRisk(base).find((x) => x.label === "Positions that move together");
    expect(d?.detail).toContain("less diversifying");
  });

  it("says when history is missing instead of staying silent", () => {
    const d = explainPortfolioRisk(base).find((x) => x.label === "Not enough history");
    expect(d?.detail).toContain("OBSCURE.NS");
    expect(d?.detail).toContain("could be higher");
  });

  it("claims nothing when there is nothing to claim", () => {
    expect(explainPortfolioRisk({ riskScore: 0, holdings: [] })).toEqual([]);
  });
});

describe("sending is opt-in, capped, and contains only the recipient's own data", () => {
  it("sends only to users who turned it on", () => {
    expect(SENDER.includes('.eq("enabled", true)')).toBe(true);
  });

  it("claims the day BEFORE calling the provider, so a retry cannot mail twice", () => {
    const claim = SENDER.indexOf('.from("user_risk_email_sends")');
    const send = SENDER.indexOf("provider.send(");
    expect(claim).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(claim);
  });

  it("caps any single run", () => {
    expect(SENDER.includes("MAX_SENDS_PER_RUN")).toBe(true);
  });

  it("re-checks access at send time, so a revoked user is not emailed", () => {
    expect(SENDER.includes('.from("app_user_roles")')).toBe(true);
    expect(SENDER.includes("revoked_at")).toBe(true);
  });

  it("is cron-gated", () => {
    expect(SENDER.includes("verifyCronSecret(req)")).toBe(true);
  });

  it("builds from the recipient's own rows only — never the owner's book", () => {
    for (const ownerTable of ["paper_positions", "paper_portfolio", "agent_signals",
                              "research_packets", "live_account_snapshots", "broker_orders"]) {
      expect(SENDER.includes(ownerTable), `email reads ${ownerTable}`).toBe(false);
    }
  });

  it("calls no LLM", () => {
    for (const llm of ["anthropic", "openai", "strategy-notes"]) {
      expect(SENDER.toLowerCase().includes(llm), `sender references ${llm}`).toBe(false);
    }
  });

  it("never returns an address or a figure to the scheduler log", () => {
    const response = SENDER.slice(SENDER.lastIndexOf("return NextResponse.json({ ok: true, hourUtc"));
    expect(response.includes("email")).toBe(false);
    expect(response.includes("summary")).toBe(false);
  });
});

describe("unsubscribe works for someone who cannot log in", () => {
  it("has no session gate at all", () => {
    expect(UNSUB.includes("getSessionRole")).toBe(false);
    expect(UNSUB.includes("requireOwner")).toBe(false);
  });

  it("answers identically for a good and a bad token, so it cannot be probed", () => {
    expect(UNSUB.includes("if (!token) return new NextResponse(body, { headers });")).toBe(true);
  });

  it("only ever turns the preference OFF", () => {
    expect(UNSUB.includes("{ enabled: false }")).toBe(true);
    expect(UNSUB.includes("enabled: true")).toBe(false);
  });

  it("answers POST as well as GET, since clients use both", () => {
    expect(UNSUB.includes("export async function POST")).toBe(true);
    expect(UNSUB.includes("export async function GET")).toBe(true);
  });
});

describe("the preference belongs to the caller", () => {
  it("takes the user id from the session, never the body", () => {
    expect(PREFS.includes("getSessionRole()")).toBe(true);
    expect(/body\?\.user_id|body\.userId/.test(PREFS)).toBe(false);
    expect(PREFS.includes("user_id: userId")).toBe(true);
  });

  it("never hands back the unsubscribe token", () => {
    expect(PREFS.includes("unsubscribe_token")).toBe(false);
  });
});
