/**
 * Deterministic capital-planning calculations. These are decision support only:
 * they neither access a broker nor initiate a payment, transfer, or trade.
 */

export type ReturnRange = { lowerPct: number; basePct: number; upperPct: number };

export type MortgagePrepaymentInput = {
  availableCash: number;
  emergencyReserve: number;
  nearTermObligations: number;
  balance: number;
  annualRatePct: number;
  remainingMonths: number;
  proposedPrincipal: number;
  prepaymentPenalty: number;
  interestDeductible: boolean;
  marginalTaxRatePct: number;
};

export type MortgagePrepaymentResult = {
  state: "review_principal_payment" | "watch" | "indifferent_under_assumptions" | "insufficient_evidence" | "outside_policy";
  liquidityAfter: number;
  liquidityFloor: number;
  scheduledInterest: number;
  interestAfterPrepayment: number;
  grossInterestSaved: number;
  estimatedAfterTaxInterestSaved: number;
  penalty: number;
  netEstimatedBenefit: number;
  monthsShortened: number;
  monthlyPayment: number;
  reason: string;
};

export type CrossAssetInput = {
  availableCash: number;
  emergencyReserve: number;
  nearTermObligations: number;
  investmentAmount: number;
  holdingYears: number;
  propertyRange: ReturnRange;
  marketRange: ReturnRange;
  propertyLiquidityRisk: "low" | "medium" | "high";
  marketLiquidityRisk: "low" | "medium" | "high";
  propertyConcentrationPct: number;
  marketConcentrationPct: number;
  evidenceQuality: "verified" | "owner_assumption" | "insufficient";
};

export type CrossAssetResult = {
  state: "review_property" | "review_market" | "indifferent_under_assumptions" | "insufficient_evidence" | "outside_policy";
  propertyTerminalRange: { lower: number; base: number; upper: number };
  marketTerminalRange: { lower: number; base: number; upper: number };
  reason: string;
};

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}
function nonNegative(name: string, value: number): number {
  finite(name, value);
  if (value < 0) throw new RangeError(`${name} must be >= 0`);
  return value;
}
function percentage(name: string, value: number): number {
  finite(name, value);
  if (value < 0 || value > 100) throw new RangeError(`${name} must be between 0 and 100`);
  return value;
}
function payment(balance: number, annualRatePct: number, months: number): number {
  const rate = annualRatePct / 1200;
  if (rate === 0) return balance / months;
  return balance * rate / (1 - Math.pow(1 + rate, -months));
}
function amortize(balance: number, annualRatePct: number, months: number, regularPayment: number) {
  const rate = annualRatePct / 1200;
  let interest = 0;
  let remaining = balance;
  let elapsed = 0;
  while (remaining > 0.005 && elapsed < months + 1) {
    const monthInterest = remaining * rate;
    const principal = Math.min(remaining, Math.max(0, regularPayment - monthInterest));
    if (principal <= 0) throw new RangeError("payment does not amortize the balance");
    interest += monthInterest;
    remaining -= principal;
    elapsed += 1;
  }
  return { interest, months: elapsed };
}
function terminal(amount: number, annualPct: number, years: number): number {
  return amount * Math.pow(1 + annualPct / 100, years);
}
function validRange(range: ReturnRange): void {
  finite("lowerPct", range.lowerPct); finite("basePct", range.basePct); finite("upperPct", range.upperPct);
  if (range.lowerPct > range.basePct || range.basePct > range.upperPct) throw new RangeError("return range must be ordered");
}

export function compareMortgagePrepayment(input: MortgagePrepaymentInput): MortgagePrepaymentResult {
  ["availableCash", "emergencyReserve", "nearTermObligations", "balance", "proposedPrincipal", "prepaymentPenalty"].forEach((key) => nonNegative(key, input[key as keyof MortgagePrepaymentInput] as number));
  percentage("annualRatePct", input.annualRatePct); percentage("marginalTaxRatePct", input.marginalTaxRatePct);
  if (!Number.isInteger(input.remainingMonths) || input.remainingMonths <= 0) throw new RangeError("remainingMonths must be a positive integer");
  const liquidityFloor = input.emergencyReserve + input.nearTermObligations;
  const liquidityAfter = input.availableCash - input.proposedPrincipal - input.prepaymentPenalty;
  const monthlyPayment = payment(input.balance, input.annualRatePct, input.remainingMonths);
  if (input.proposedPrincipal <= 0 || input.balance <= 0) return { state: "insufficient_evidence", liquidityAfter, liquidityFloor, scheduledInterest: 0, interestAfterPrepayment: 0, grossInterestSaved: 0, estimatedAfterTaxInterestSaved: 0, penalty: input.prepaymentPenalty, netEstimatedBenefit: 0, monthsShortened: 0, monthlyPayment, reason: "Enter a positive current balance and proposed principal payment." };
  if (input.proposedPrincipal >= input.balance) return { state: "outside_policy", liquidityAfter, liquidityFloor, scheduledInterest: 0, interestAfterPrepayment: 0, grossInterestSaved: 0, estimatedAfterTaxInterestSaved: 0, penalty: input.prepaymentPenalty, netEstimatedBenefit: 0, monthsShortened: 0, monthlyPayment, reason: "This calculator supports a partial principal payment only; obtain a payoff statement for a full payoff." };
  const scheduled = amortize(input.balance, input.annualRatePct, input.remainingMonths, monthlyPayment);
  const after = amortize(input.balance - input.proposedPrincipal, input.annualRatePct, input.remainingMonths, monthlyPayment);
  const grossInterestSaved = scheduled.interest - after.interest;
  const estimatedAfterTaxInterestSaved = grossInterestSaved * (input.interestDeductible ? 1 - input.marginalTaxRatePct / 100 : 1);
  const netEstimatedBenefit = estimatedAfterTaxInterestSaved - input.prepaymentPenalty;
  const base = { liquidityAfter, liquidityFloor, scheduledInterest: scheduled.interest, interestAfterPrepayment: after.interest, grossInterestSaved, estimatedAfterTaxInterestSaved, penalty: input.prepaymentPenalty, netEstimatedBenefit, monthsShortened: Math.max(0, scheduled.months - after.months), monthlyPayment };
  if (liquidityAfter < liquidityFloor) return { ...base, state: "outside_policy", reason: "The payment would take liquid cash below the owner-entered reserve and near-term-obligation floor." };
  if (netEstimatedBenefit <= 0) return { ...base, state: "watch", reason: "Estimated after-tax interest savings do not clear the stated penalty under these assumptions." };
  return { ...base, state: "review_principal_payment", reason: "The partial payment preserves the stated liquidity floor and has positive estimated after-tax interest savings. This is not a lender payoff quote or a payment instruction." };
}

export function compareCrossAsset(input: CrossAssetInput): CrossAssetResult {
  ["availableCash", "emergencyReserve", "nearTermObligations", "investmentAmount", "propertyConcentrationPct", "marketConcentrationPct"].forEach((key) => nonNegative(key, input[key as keyof CrossAssetInput] as number));
  if (!Number.isFinite(input.holdingYears) || input.holdingYears <= 0) throw new RangeError("holdingYears must be positive");
  validRange(input.propertyRange); validRange(input.marketRange);
  const toRange = (range: ReturnRange) => ({ lower: terminal(input.investmentAmount, range.lowerPct, input.holdingYears), base: terminal(input.investmentAmount, range.basePct, input.holdingYears), upper: terminal(input.investmentAmount, range.upperPct, input.holdingYears) });
  const propertyTerminalRange = toRange(input.propertyRange); const marketTerminalRange = toRange(input.marketRange);
  if (input.availableCash - input.investmentAmount < input.emergencyReserve + input.nearTermObligations) return { state: "outside_policy", propertyTerminalRange, marketTerminalRange, reason: "Either allocation would breach the owner-entered cash floor." };
  if (input.evidenceQuality === "insufficient") return { state: "insufficient_evidence", propertyTerminalRange, marketTerminalRange, reason: "Use verified or explicitly owner-assumed return ranges before comparing allocations." };
  const propertyRisky = input.propertyLiquidityRisk === "high" || input.propertyConcentrationPct > 50;
  const marketRisky = input.marketLiquidityRisk === "high" || input.marketConcentrationPct > 50;
  const spread = propertyTerminalRange.base - marketTerminalRange.base;
  const tolerance = input.investmentAmount * 0.03;
  if (Math.abs(spread) <= tolerance || (propertyRisky && marketRisky)) return { state: "indifferent_under_assumptions", propertyTerminalRange, marketTerminalRange, reason: "The ranges overlap after applying the stated horizon and constraints. Do not treat a midpoint as a ranking." };
  if (spread > 0 && !propertyRisky) return { state: "review_property", propertyTerminalRange, marketTerminalRange, reason: "The property scenario has the higher stated midpoint without breaching the explicit liquidity or concentration checks." };
  if (spread < 0 && !marketRisky) return { state: "review_market", propertyTerminalRange, marketTerminalRange, reason: "The market scenario has the higher stated midpoint without breaching the explicit liquidity or concentration checks." };
  return { state: "indifferent_under_assumptions", propertyTerminalRange, marketTerminalRange, reason: "The apparent midpoint advantage belongs to the more concentrated or less liquid choice, so the result remains a review decision." };
}
