// Insider score v2 (shadow only). Pure functions: no imports, safe in tests.
//
// Problem (docs/audits/2026-10-14-us-book-vs-xlk-and-score-quality.md): the live insider score treats every open-market sale (Form 4 code S) as
// bearish, so a company whose executives only sell on pre-arranged Rule 10b5-1 plans scores 10 ("0 buys vs 105 sells"). Planned sales say
// little about conviction. Form 4 carries a filing-level checkbox, <aff10b5One>true|false</aff10b5One> (verified on real AAPL filings
// 2026-10-14: true on routine sale filings, false on option-exercise/tax filings). Filings without the tag are 'unknown', not guessed.
//
// v1 here = the same logic as the live scorer (all P and S, >= MIN transactions) computed from the SAME filings, so v1 vs v2 is paired.
// v2 = open-market buys plus DISCRETIONARY sales only (planned sales ignored), available only with >= MIN such transactions.

export const MIN_TRANSACTIONS = 3;

export interface Form4Txn { code: string; value: number }
export interface Form4Filing { planned: boolean | null; txns: Form4Txn[] }

/** Parse one Form 4 XML: the filing-level 10b5-1 flag (null when the tag is absent) and every non-derivative transaction. */
export function parseForm4Detailed(xml: string): Form4Filing {
  const flag = xml.match(/<aff10b5One>\s*([^<\s]*)\s*<\/aff10b5One>/i)?.[1]?.toLowerCase();
  const planned = flag === "true" || flag === "1" ? true : flag === "false" || flag === "0" ? false : null;
  const txns: Form4Txn[] = [];
  for (const m of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)) {
    const block = m[1];
    const shares = parseFloat(block.match(/<transactionShares>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "0") || 0;
    const price = parseFloat(block.match(/<transactionPricePerShare>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "0") || 0;
    const code = block.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/i)?.[1]?.trim().toUpperCase() ?? "";
    if (shares > 0) txns.push({ code, value: shares * price });
  }
  return { planned, txns };
}

export interface InsiderV2Result {
  buyCount: number; buyValue: number;
  plannedSellCount: number; plannedSellValue: number;
  discretionarySellCount: number; discretionarySellValue: number;
  unknownSellCount: number; unknownSellValue: number;
  v1Score: number | null; v1Available: boolean;
  v2Score: number | null; v2Available: boolean;
}

const scoreFrom = (buy: number, sell: number) => Math.round(10 + (buy / (buy + sell)) * 80); // same mapping as the live scorer

export function scoreInsiderV1V2(filings: readonly Form4Filing[]): InsiderV2Result {
  const r: InsiderV2Result = {
    buyCount: 0, buyValue: 0, plannedSellCount: 0, plannedSellValue: 0, discretionarySellCount: 0, discretionarySellValue: 0,
    unknownSellCount: 0, unknownSellValue: 0, v1Score: null, v1Available: false, v2Score: null, v2Available: false,
  };
  for (const f of filings) {
    for (const t of f.txns) {
      if (t.code === "P") { r.buyCount++; r.buyValue += t.value; }
      else if (t.code === "S") {
        if (f.planned === true) { r.plannedSellCount++; r.plannedSellValue += t.value; }
        else if (f.planned === false) { r.discretionarySellCount++; r.discretionarySellValue += t.value; }
        else { r.unknownSellCount++; r.unknownSellValue += t.value; }
      }
    }
  }
  const allSellCount = r.plannedSellCount + r.discretionarySellCount + r.unknownSellCount;
  const allSellValue = r.plannedSellValue + r.discretionarySellValue + r.unknownSellValue;
  if (r.buyCount + allSellCount >= MIN_TRANSACTIONS && r.buyValue + allSellValue > 0) { r.v1Score = scoreFrom(r.buyValue, allSellValue); r.v1Available = true; }
  if (r.buyCount + r.discretionarySellCount >= MIN_TRANSACTIONS && r.buyValue + r.discretionarySellValue > 0) { r.v2Score = scoreFrom(r.buyValue, r.discretionarySellValue); r.v2Available = true; }
  return r;
}
