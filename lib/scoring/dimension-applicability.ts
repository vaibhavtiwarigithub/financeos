import { isEtfSymbol } from "@/lib/asset-classification";
import { classifyInstrumentPolicy, CRYPTO_SYMBOLS, isFundFamily } from "@/lib/scoring/instrument-taxonomy";
import { isReviewedAdr } from "@/lib/instruments/adrs";
import type { DimensionRecord, ScoreDimension } from "@/lib/scoring/weighted-score";

export type DimensionApplicabilityState = "applicable" | "not_applicable" | "not_enabled";
export type DimensionApplicability = Record<ScoreDimension, {
  state: DimensionApplicabilityState;
  reason: string;
}>;
export type ResearchDimension = ScoreDimension | "options" | "analyst";

function isFundInstrument(symbol: string, market: "us" | "india", explicitEtf?: boolean): boolean {
  if (explicitEtf === true || isEtfSymbol(symbol)) return true;
  return isFundFamily(classifyInstrumentPolicy({ symbol, market }).family);
}

/**
 * Describes whether each currently scored dimension belongs in this instrument's
 * active composite. This is structural policy, not evidence availability: an
 * applicable dimension can still be missing or stale on a particular run.
 */
export function dimensionApplicability(input: {
  symbol: string;
  market: "us" | "india";
  isEtf?: boolean;
  fundamentalEvidence?: Record<string, unknown> | null;
}): DimensionApplicability {
  const symbol = input.symbol.trim().toUpperCase();
  const india = input.market === "india" || symbol.endsWith(".NS") || symbol.endsWith(".BO");
  const crypto = CRYPTO_SYMBOLS.has(symbol);
  const fund = isFundInstrument(symbol, india ? "india" : "us", input.isEtf);
  const adr = !india && isReviewedAdr(symbol);
  const result: DimensionApplicability = {
    fundamental: { state: "applicable", reason: "Issuer financial statements are relevant to this operating company." },
    technical: { state: "applicable", reason: "Price and volume behavior applies to this tradable instrument; current coverage is evaluated separately." },
    sentiment: { state: "applicable", reason: "The active US/crypto sentiment input is relevant; missing feed evidence is reported separately." },
    macro: { state: "applicable", reason: "The active market-level macro context is part of this market's current composite." },
    insider: { state: "applicable", reason: "Issuer insider transactions are part of the active US-equity composite when real data is available." },
  };

  if (fund || crypto) {
    result.fundamental = {
      state: "not_applicable",
      reason: crypto
        ? "Company ratios such as ROE, P/E and PEG do not describe a crypto asset; tokenomics/network measures are a separate, not-yet-promoted feature pack."
        : "This fund has no single-company earnings or balance sheet; issuer ROE, P/E and PEG are not applicable. Fund holdings/structure evidence is measured separately.",
    };
    result.insider = {
      state: "not_applicable",
      reason: crypto ? "Corporate Form 4 insider transactions do not apply to a crypto asset." : "A fund has no single operating-company insider transactions.",
    };
  }

  if (crypto) {
    result.sentiment.reason = "Crypto sentiment is part of the separate crypto research contract; its availability is recorded independently.";
    result.macro.reason = "The crypto paper research contract includes this macro context; this does not imply it is a validated alpha signal.";
  } else if (india) {
    result.sentiment = {
      state: "not_enabled",
      reason: "Sentiment may be relevant, but no validated India sentiment score is active in this composite; India news evidence remains a separate shadow.",
    };
    result.macro = {
      state: "not_enabled",
      reason: "Macro is relevant, but the active macro score is US-market-wide and must not be stamped onto Indian equities.",
    };
    if (!fund) {
      result.insider = {
        state: "not_enabled",
        reason: "Insider activity is relevant, but the available SEBI PIT feed did not qualify for a comparable active score; it remains excluded.",
      };
    }
  }

  if (adr) {
    result.insider = {
      state: "not_applicable",
      reason: "The current Form 4 score contract does not cover foreign issuers represented by ADRs; ADS-safe fundamentals remain applicable.",
    };
  }

  // scoreFundamentals currently returns a neutral placeholder for REITs because
  // the available P/E, net-income margin, ROE and EPS inputs are distorted by
  // depreciation. Keep the fetch for classification, but do not let the 55
  // placeholder contribute until an FFO/AFFO contract exists.
  const fundApplicability = String(input.fundamentalEvidence?.applicability ?? "");
  if (!india && !fund && fundApplicability === "not_enabled") {
    result.fundamental = {
      state: "not_enabled",
      reason: "The available generic ratios are distorted for REITs; the neutral placeholder is excluded until qualified FFO/AFFO data and scoring are available.",
    };
  }

  return result;
}

export function activeScoredDimensions(applicability: DimensionApplicability): Set<ScoreDimension> {
  return new Set((Object.keys(applicability) as ScoreDimension[])
    .filter((dimension) => applicability[dimension].state === "applicable"));
}

/**
 * Research evidence collection set. Options and analyst consensus are
 * evidence-only inputs, not terms in the five-dimension composite.
 */
export function applicableResearchDimensions(input: {
  symbol: string;
  market: "us" | "india";
  isEtf?: boolean;
}): Set<ResearchDimension> {
  const symbol = input.symbol.trim().toUpperCase();
  const india = input.market === "india" || symbol.endsWith(".NS") || symbol.endsWith(".BO");
  const fund = isFundInstrument(symbol, india ? "india" : "us", input.isEtf);
  const crypto = CRYPTO_SYMBOLS.has(symbol);
  const dimensions: Set<ResearchDimension> = new Set(activeScoredDimensions(dimensionApplicability(input)));
  if (!india && !fund && !crypto) {
    dimensions.add("options");
    dimensions.add("analyst");
  }
  return dimensions;
}

/**
 * A feed can only enter the composite if its dimension is structurally
 * applicable as well as successfully present in this run.
 */
export function availableScoredDimensions(
  applicability: DimensionApplicability,
  available: Partial<DimensionRecord<boolean>>,
): DimensionRecord<boolean> {
  return Object.fromEntries((Object.keys(applicability) as ScoreDimension[]).map((dimension) => [
    dimension,
    applicability[dimension].state === "applicable" && available[dimension] === true,
  ])) as DimensionRecord<boolean>;
}
