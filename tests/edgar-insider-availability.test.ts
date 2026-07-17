import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreEdgarInsider } from "@/lib/data/edgar-insider";

// These tests pin the honesty contract of the insider scorer:
//   - a failed fetch must NOT be laundered into a plausible-looking finding
//   - "unavailable" must be distinguishable from "genuinely neutral"
//
// Before the 2026-07-16 fix, every Form 4 URL 404'd and this scorer reported
// "too few transactions to score" — the same thing a genuinely quiet issuer
// produces. The failure was invisible by construction.

const CIK_MAP = { "0": { cik_str: 1403161, ticker: "V", title: "VISA INC." } };

function submissionsJson(count: number) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    filings: {
      recent: {
        form: Array(count).fill("4"),
        filingDate: Array(count).fill(today),
        accessionNumber: Array.from({ length: count }, (_, i) => `0001403161-26-0000${90 + i}`),
        primaryDocument: Array(count).fill("xslF345X06/form4.xml"),
      },
    },
  };
}

// A minimal but realistic Form 4: `value`-wrapped fields, transactionCode-driven.
function form4Xml(code: "P" | "S", shares: number, price: number) {
  return `<?xml version="1.0"?><ownershipDocument>
    <reportingOwner><reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId></reportingOwner>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-07-01</value></transactionDate>
      <transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>${shares}</value></transactionShares>
        <transactionPricePerShare><value>${price}</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </ownershipDocument>`;
}

function mockFetch(handler: (url: string) => { ok: boolean; body?: any; text?: string }) {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = String(input);
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.ok ? 200 : 404,
      json: async () => r.body,
      text: async () => r.text ?? "",
    } as any;
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("scoreEdgarInsider — failure is never a finding", () => {
  it("reports unavailable-with-reason when every Form 4 fetch 404s", async () => {
    mockFetch((url) => {
      if (url.includes("company_tickers")) return { ok: true, body: CIK_MAP };
      if (url.includes("submissions")) return { ok: true, body: submissionsJson(4) };
      return { ok: false }; // every XML 404s — the pre-fix production reality
    });

    const result = await scoreEdgarInsider("V");

    expect(result.available).toBe(false);
    // The reason must name the failure, not imply we looked and found little.
    expect(result.summary).toMatch(/fetch failed/i);
    expect(result.summary).not.toMatch(/too few/i);
  });

  it("does not silently yield an empty/neutral result on a total fetch failure", async () => {
    mockFetch((url) => {
      if (url.includes("company_tickers")) return { ok: true, body: CIK_MAP };
      if (url.includes("submissions")) return { ok: true, body: submissionsJson(3) };
      return { ok: false };
    });

    const result = await scoreEdgarInsider("V");
    // 50 is the inert placeholder, but it MUST be flagged unavailable so no
    // consumer can read it as evidence.
    expect(result).toMatchObject({ score: 50, available: false });
  });

  it("treats a failed submissions index as unavailable, not as 'no filings'", async () => {
    mockFetch((url) => {
      if (url.includes("company_tickers")) return { ok: true, body: CIK_MAP };
      return { ok: false }; // submissions index itself is down
    });

    const result = await scoreEdgarInsider("V");
    expect(result.available).toBe(false);
    expect(result.summary).toMatch(/fetch failed/i);
  });
});

describe("scoreEdgarInsider — unavailable vs genuinely neutral", () => {
  it("distinguishes a real balanced 50 from an unavailable 50", async () => {
    // Two buys and two sells of equal value => buyRatio 0.5 => score 50, but
    // this 50 is REAL data and must be marked available:true. This is the case
    // that makes "treat any 50 as unavailable" wrong.
    const xmls = [
      form4Xml("P", 100, 10),
      form4Xml("P", 100, 10),
      form4Xml("S", 100, 10),
      form4Xml("S", 100, 10),
    ];
    let i = 0;
    mockFetch((url) => {
      if (url.includes("company_tickers")) return { ok: true, body: CIK_MAP };
      if (url.includes("submissions")) return { ok: true, body: submissionsJson(4) };
      return { ok: true, text: xmls[i++] };
    });

    const real = await scoreEdgarInsider("V");
    expect(real).toMatchObject({ score: 50, available: true });
    expect(real.summary).toMatch(/Buy ratio 50%/);

    vi.unstubAllGlobals();

    // Same score, opposite meaning.
    mockFetch((url) => {
      if (url.includes("company_tickers")) return { ok: true, body: CIK_MAP };
      if (url.includes("submissions")) return { ok: true, body: submissionsJson(4) };
      return { ok: false };
    });
    const broken = await scoreEdgarInsider("V");

    expect(broken.score).toBe(real.score); // identical number...
    expect(broken.available).not.toBe(real.available); // ...distinguishable fact
  });

  it("scores a real net-buying issuer as available", async () => {
    const xmls = [form4Xml("P", 100, 10), form4Xml("P", 100, 10), form4Xml("P", 100, 10)];
    let i = 0;
    mockFetch((url) => {
      if (url.includes("company_tickers")) return { ok: true, body: CIK_MAP };
      if (url.includes("submissions")) return { ok: true, body: submissionsJson(3) };
      return { ok: true, text: xmls[i++] };
    });

    const result = await scoreEdgarInsider("V");
    expect(result.available).toBe(true);
    expect(result.score).toBe(90); // 100% buying
  });

  it("flags a partial read as a floor rather than a complete count", async () => {
    let n = 0;
    mockFetch((url) => {
      if (url.includes("company_tickers")) return { ok: true, body: CIK_MAP };
      if (url.includes("submissions")) return { ok: true, body: submissionsJson(4) };
      n++;
      return n === 1 ? { ok: true, text: form4Xml("P", 100, 10) } : { ok: false };
    });

    const result = await scoreEdgarInsider("V");
    expect(result.available).toBe(false);
    expect(result.summary).toMatch(/could not be read/i);
  });
});
