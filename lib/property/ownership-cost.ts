import { calculateMortgage } from "@/lib/property/scenarios";

export type OwnershipCostInput = {
  loanBalance: number;
  annualMortgageRatePct: number;
  remainingTermMonths: number;
  annualPropertyTax: number;
  annualInsurance: number;
  annualMaintenance: number;
  monthlyHoa: number;
  monthlyOther: number;
};

export type OwnershipCostBreakdown = {
  principalAndInterest: number;
  propertyTax: number;
  insurance: number;
  maintenance: number;
  hoa: number;
  other: number;
  total: number;
};

export function calculateOwnershipCost(input: OwnershipCostInput): OwnershipCostBreakdown {
  const annualFields = [input.annualPropertyTax, input.annualInsurance, input.annualMaintenance];
  const monthlyFields = [input.monthlyHoa, input.monthlyOther];
  if ([input.loanBalance, input.annualMortgageRatePct, input.remainingTermMonths, ...annualFields, ...monthlyFields].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("Ownership cost inputs must be finite and non-negative");
  }
  const principalAndInterest = input.loanBalance === 0
    ? 0
    : calculateMortgage({
        principal: input.loanBalance,
        annualRatePct: input.annualMortgageRatePct,
        termMonths: input.remainingTermMonths,
      }).monthlyPayment;
  const result = {
    principalAndInterest,
    propertyTax: input.annualPropertyTax / 12,
    insurance: input.annualInsurance / 12,
    maintenance: input.annualMaintenance / 12,
    hoa: input.monthlyHoa,
    other: input.monthlyOther,
  };
  return { ...result, total: Object.values(result).reduce((sum, value) => sum + value, 0) };
}
