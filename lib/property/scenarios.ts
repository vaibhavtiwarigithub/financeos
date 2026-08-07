/**
 * Deterministic, currency-neutral property and financing calculations.
 * Rates ending in `Pct` are percentages (6.5 means 6.5%), while monetary
 * inputs must all use the same caller-selected currency.
 */

export type MortgageInput = {
  principal: number;
  annualRatePct: number;
  termMonths: number;
};

export type MortgageSummary = {
  monthlyPayment: number;
  totalPayment: number;
  totalInterest: number;
};

export type AmortizationRow = {
  month: number;
  payment: number;
  principal: number;
  interest: number;
  endingBalance: number;
};

export type RefinanceInput = {
  balance: number;
  currentAnnualRatePct: number;
  currentRemainingMonths: number;
  newAnnualRatePct: number;
  newTermMonths: number;
  closingCosts: number;
  annualDiscountRatePct?: number;
};

export type RefinanceResult = {
  currentMonthlyPayment: number;
  newMonthlyPayment: number;
  initialMonthlySavings: number;
  breakevenMonth: number | null;
  npvBenefit: number;
  terminalUndiscountedBenefit: number;
  isNpvPositive: boolean;
};

export type RateShockInput = {
  instrument: "heloc" | "lap";
  balance: number;
  currentAnnualRatePct: number;
  shockedAnnualRatePct: number;
  repaymentMode: "interest_only" | "amortizing";
  remainingTermMonths?: number;
};

export type RateShockResult = {
  currentMonthlyPayment: number;
  shockedMonthlyPayment: number;
  monthlyPaymentChange: number;
  annualPaymentChange: number;
  paymentChangePct: number | null;
};

export type RentalEconomicsInput = {
  purchasePrice: number;
  cashInvested: number;
  monthlyGrossRent: number;
  vacancyPct: number;
  annualOperatingExpenses: number;
  annualDebtService: number;
};

export type RentalEconomicsResult = {
  effectiveGrossIncome: number;
  netOperatingIncome: number;
  annualCashFlow: number;
  monthlyCashFlow: number;
  capRatePct: number;
  cashOnCashReturnPct: number;
  dscr: number | null;
};

export type BuyVsRentInput = {
  horizonMonths: number;
  purchasePrice: number;
  downPayment: number;
  mortgageAnnualRatePct: number;
  mortgageTermMonths: number;
  purchaseCostPct: number;
  saleCostPct: number;
  annualAppreciationPct: number;
  annualPropertyTax: number;
  annualInsurance: number;
  annualMaintenance: number;
  monthlyHoa: number;
  monthlyRent: number;
  annualRentGrowthPct: number;
  annualInvestmentReturnPct: number;
  annualOwnerCostGrowthPct?: number;
};

export type BuyVsRentResult = {
  endingHomeValue: number;
  endingMortgageBalance: number;
  buyerNetWorth: number;
  renterNetWorth: number;
  buyAdvantage: number;
  financiallyPreferred: "buy" | "rent" | "tie";
  totalOwnerHousingCost: number;
  totalRentPaid: number;
};

export type PropertyDownsideInput = {
  propertyValue: number;
  loanBalance: number;
  monthlyGrossRent: number;
  vacancyPct: number;
  annualOperatingExpenses: number;
  annualRatePct: number;
  remainingTermMonths: number;
  shock: {
    propertyValueChangePct: number;
    rentChangePct: number;
    vacancyChangePctPoints: number;
    operatingExpenseChangePct: number;
    rateChangeBps: number;
  };
};

export type PropertyDownsideState = {
  propertyValue: number;
  equity: number;
  ltvPct: number;
  monthlyDebtService: number;
  monthlyCashFlow: number;
  dscr: number | null;
};

export type PropertyDownsideResult = {
  baseline: PropertyDownsideState;
  stressed: PropertyDownsideState;
  equityChange: number;
  monthlyCashFlowChange: number;
  breaches: Array<"negative_equity" | "negative_cash_flow" | "dscr_below_one">;
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

function positive(name: string, value: number): number {
  finite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be > 0`);
  return value;
}

function positiveInteger(name: string, value: number): number {
  positive(name, value);
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer`);
  return value;
}

function percentage(name: string, value: number, min = 0, max = 100): number {
  finite(name, value);
  if (value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function growthRate(name: string, value: number): number {
  finite(name, value);
  if (value <= -100) throw new RangeError(`${name} must be > -100`);
  return value;
}

function monthlyRate(annualRatePct: number): number {
  nonNegative("annualRatePct", annualRatePct);
  return annualRatePct / 1_200;
}

function monthlyGrowth(annualPct: number): number {
  growthRate("annual growth rate", annualPct);
  return Math.pow(1 + annualPct / 100, 1 / 12) - 1;
}

function payment(principal: number, annualRatePct: number, termMonths: number): number {
  nonNegative("principal", principal);
  positiveInteger("termMonths", termMonths);
  const rate = monthlyRate(annualRatePct);
  if (principal === 0) return 0;
  if (rate === 0) return principal / termMonths;
  return principal * rate / (1 - Math.pow(1 + rate, -termMonths));
}

export function calculateMortgage(input: MortgageInput): MortgageSummary {
  const monthlyPayment = payment(input.principal, input.annualRatePct, input.termMonths);
  const totalPayment = monthlyPayment * input.termMonths;
  return {
    monthlyPayment,
    totalPayment,
    totalInterest: totalPayment - input.principal,
  };
}

export function buildAmortizationSchedule(input: MortgageInput): AmortizationRow[] {
  nonNegative("principal", input.principal);
  positiveInteger("termMonths", input.termMonths);
  const rate = monthlyRate(input.annualRatePct);
  const regularPayment = payment(input.principal, input.annualRatePct, input.termMonths);
  const rows: AmortizationRow[] = [];
  let balance = input.principal;

  for (let month = 1; month <= input.termMonths; month += 1) {
    const interest = balance * rate;
    const principal = month === input.termMonths
      ? balance
      : Math.min(balance, Math.max(0, regularPayment - interest));
    const actualPayment = principal + interest;
    balance = Math.max(0, balance - principal);
    rows.push({ month, payment: actualPayment, principal, interest, endingBalance: balance });
  }
  return rows;
}

export function evaluateRefinance(input: RefinanceInput): RefinanceResult {
  positive("balance", input.balance);
  nonNegative("closingCosts", input.closingCosts);
  positiveInteger("currentRemainingMonths", input.currentRemainingMonths);
  positiveInteger("newTermMonths", input.newTermMonths);
  const discountRatePct = input.annualDiscountRatePct ?? 0;
  nonNegative("annualDiscountRatePct", discountRatePct);

  const current = calculateMortgage({
    principal: input.balance,
    annualRatePct: input.currentAnnualRatePct,
    termMonths: input.currentRemainingMonths,
  });
  const replacement = calculateMortgage({
    principal: input.balance,
    annualRatePct: input.newAnnualRatePct,
    termMonths: input.newTermMonths,
  });
  const discountRate = monthlyRate(discountRatePct);
  const comparisonMonths = Math.max(input.currentRemainingMonths, input.newTermMonths);
  let cumulativeBenefit = -input.closingCosts;
  let npvBenefit = -input.closingCosts;
  const cumulativeBenefits = [cumulativeBenefit];

  for (let month = 1; month <= comparisonMonths; month += 1) {
    const currentOutflow = month <= input.currentRemainingMonths ? current.monthlyPayment : 0;
    const newOutflow = month <= input.newTermMonths ? replacement.monthlyPayment : 0;
    const benefit = currentOutflow - newOutflow;
    cumulativeBenefit += benefit;
    cumulativeBenefits.push(cumulativeBenefit);
    npvBenefit += benefit / Math.pow(1 + discountRate, month);
  }

  // A temporary crossing is not a real breakeven when a term extension makes
  // cumulative savings negative again later in the comparison horizon.
  let breakevenMonth: number | null = null;
  let futureMinimum = Number.POSITIVE_INFINITY;
  for (let month = cumulativeBenefits.length - 1; month >= 0; month -= 1) {
    futureMinimum = Math.min(futureMinimum, cumulativeBenefits[month]);
    if (futureMinimum >= 0) breakevenMonth = month;
  }

  return {
    currentMonthlyPayment: current.monthlyPayment,
    newMonthlyPayment: replacement.monthlyPayment,
    initialMonthlySavings: current.monthlyPayment - replacement.monthlyPayment,
    breakevenMonth,
    npvBenefit,
    terminalUndiscountedBenefit: cumulativeBenefit,
    isNpvPositive: npvBenefit > 0,
  };
}

export function evaluateRateShock(input: RateShockInput): RateShockResult {
  positive("balance", input.balance);
  nonNegative("currentAnnualRatePct", input.currentAnnualRatePct);
  nonNegative("shockedAnnualRatePct", input.shockedAnnualRatePct);
  let currentMonthlyPayment: number;
  let shockedMonthlyPayment: number;

  if (input.repaymentMode === "interest_only") {
    currentMonthlyPayment = input.balance * input.currentAnnualRatePct / 1_200;
    shockedMonthlyPayment = input.balance * input.shockedAnnualRatePct / 1_200;
  } else {
    const termMonths = positiveInteger("remainingTermMonths", input.remainingTermMonths ?? 0);
    currentMonthlyPayment = payment(input.balance, input.currentAnnualRatePct, termMonths);
    shockedMonthlyPayment = payment(input.balance, input.shockedAnnualRatePct, termMonths);
  }

  const monthlyPaymentChange = shockedMonthlyPayment - currentMonthlyPayment;
  return {
    currentMonthlyPayment,
    shockedMonthlyPayment,
    monthlyPaymentChange,
    annualPaymentChange: monthlyPaymentChange * 12,
    paymentChangePct: currentMonthlyPayment === 0
      ? null
      : monthlyPaymentChange / currentMonthlyPayment * 100,
  };
}

export function evaluateRentalEconomics(input: RentalEconomicsInput): RentalEconomicsResult {
  positive("purchasePrice", input.purchasePrice);
  positive("cashInvested", input.cashInvested);
  nonNegative("monthlyGrossRent", input.monthlyGrossRent);
  percentage("vacancyPct", input.vacancyPct);
  nonNegative("annualOperatingExpenses", input.annualOperatingExpenses);
  nonNegative("annualDebtService", input.annualDebtService);

  const effectiveGrossIncome = input.monthlyGrossRent * 12 * (1 - input.vacancyPct / 100);
  const netOperatingIncome = effectiveGrossIncome - input.annualOperatingExpenses;
  const annualCashFlow = netOperatingIncome - input.annualDebtService;
  return {
    effectiveGrossIncome,
    netOperatingIncome,
    annualCashFlow,
    monthlyCashFlow: annualCashFlow / 12,
    capRatePct: netOperatingIncome / input.purchasePrice * 100,
    cashOnCashReturnPct: annualCashFlow / input.cashInvested * 100,
    dscr: input.annualDebtService === 0 ? null : netOperatingIncome / input.annualDebtService,
  };
}

export function evaluateBuyVsRent(input: BuyVsRentInput): BuyVsRentResult {
  positiveInteger("horizonMonths", input.horizonMonths);
  positive("purchasePrice", input.purchasePrice);
  nonNegative("downPayment", input.downPayment);
  if (input.downPayment > input.purchasePrice) {
    throw new RangeError("downPayment must not exceed purchasePrice");
  }
  positiveInteger("mortgageTermMonths", input.mortgageTermMonths);
  if (input.horizonMonths > input.mortgageTermMonths) {
    throw new RangeError("horizonMonths must not exceed mortgageTermMonths");
  }
  percentage("purchaseCostPct", input.purchaseCostPct);
  percentage("saleCostPct", input.saleCostPct);
  growthRate("annualAppreciationPct", input.annualAppreciationPct);
  growthRate("annualRentGrowthPct", input.annualRentGrowthPct);
  growthRate("annualInvestmentReturnPct", input.annualInvestmentReturnPct);
  growthRate("annualOwnerCostGrowthPct", input.annualOwnerCostGrowthPct ?? 0);
  nonNegative("annualPropertyTax", input.annualPropertyTax);
  nonNegative("annualInsurance", input.annualInsurance);
  nonNegative("annualMaintenance", input.annualMaintenance);
  nonNegative("monthlyHoa", input.monthlyHoa);
  nonNegative("monthlyRent", input.monthlyRent);

  const loanPrincipal = input.purchasePrice - input.downPayment;
  const schedule = buildAmortizationSchedule({
    principal: loanPrincipal,
    annualRatePct: input.mortgageAnnualRatePct,
    termMonths: input.mortgageTermMonths,
  });
  const investmentGrowth = monthlyGrowth(input.annualInvestmentReturnPct);
  const rentGrowth = monthlyGrowth(input.annualRentGrowthPct);
  const ownerCostGrowth = monthlyGrowth(input.annualOwnerCostGrowthPct ?? 0);
  const homeGrowth = monthlyGrowth(input.annualAppreciationPct);
  const purchaseCosts = input.purchasePrice * input.purchaseCostPct / 100;
  let renterPortfolio = input.downPayment + purchaseCosts;
  let buyerPortfolio = 0;
  let rent = input.monthlyRent;
  let recurringOwnerCost = (
    input.annualPropertyTax + input.annualInsurance + input.annualMaintenance
  ) / 12 + input.monthlyHoa;
  let homeValue = input.purchasePrice;
  let totalOwnerHousingCost = purchaseCosts;
  let totalRentPaid = 0;

  for (let month = 0; month < input.horizonMonths; month += 1) {
    renterPortfolio *= 1 + investmentGrowth;
    buyerPortfolio *= 1 + investmentGrowth;
    const ownerCost = schedule[month].payment + recurringOwnerCost;
    totalOwnerHousingCost += ownerCost;
    totalRentPaid += rent;
    if (ownerCost > rent) renterPortfolio += ownerCost - rent;
    if (rent > ownerCost) buyerPortfolio += rent - ownerCost;
    homeValue *= 1 + homeGrowth;
    rent *= 1 + rentGrowth;
    recurringOwnerCost *= 1 + ownerCostGrowth;
  }

  const endingMortgageBalance = schedule[input.horizonMonths - 1].endingBalance;
  const buyerNetWorth = homeValue * (1 - input.saleCostPct / 100)
    - endingMortgageBalance + buyerPortfolio;
  const renterNetWorth = renterPortfolio;
  const buyAdvantage = buyerNetWorth - renterNetWorth;
  const epsilon = Math.max(1, input.purchasePrice) * 1e-10;

  return {
    endingHomeValue: homeValue,
    endingMortgageBalance,
    buyerNetWorth,
    renterNetWorth,
    buyAdvantage,
    financiallyPreferred: Math.abs(buyAdvantage) <= epsilon ? "tie" : buyAdvantage > 0 ? "buy" : "rent",
    totalOwnerHousingCost,
    totalRentPaid,
  };
}

function downsideState(input: {
  propertyValue: number;
  loanBalance: number;
  monthlyGrossRent: number;
  vacancyPct: number;
  annualOperatingExpenses: number;
  annualRatePct: number;
  remainingTermMonths: number;
}): PropertyDownsideState {
  positive("propertyValue", input.propertyValue);
  nonNegative("loanBalance", input.loanBalance);
  nonNegative("monthlyGrossRent", input.monthlyGrossRent);
  percentage("vacancyPct", input.vacancyPct);
  nonNegative("annualOperatingExpenses", input.annualOperatingExpenses);
  const monthlyDebtService = payment(input.loanBalance, input.annualRatePct, input.remainingTermMonths);
  const noi = input.monthlyGrossRent * 12 * (1 - input.vacancyPct / 100)
    - input.annualOperatingExpenses;
  return {
    propertyValue: input.propertyValue,
    equity: input.propertyValue - input.loanBalance,
    ltvPct: input.loanBalance / input.propertyValue * 100,
    monthlyDebtService,
    monthlyCashFlow: noi / 12 - monthlyDebtService,
    dscr: monthlyDebtService === 0 ? null : noi / (monthlyDebtService * 12),
  };
}

export function evaluatePropertyDownside(input: PropertyDownsideInput): PropertyDownsideResult {
  positiveInteger("remainingTermMonths", input.remainingTermMonths);
  growthRate("propertyValueChangePct", input.shock.propertyValueChangePct);
  growthRate("rentChangePct", input.shock.rentChangePct);
  growthRate("operatingExpenseChangePct", input.shock.operatingExpenseChangePct);
  finite("vacancyChangePctPoints", input.shock.vacancyChangePctPoints);
  finite("rateChangeBps", input.shock.rateChangeBps);

  const stressedVacancy = input.vacancyPct + input.shock.vacancyChangePctPoints;
  percentage("stressed vacancyPct", stressedVacancy);
  const stressedRate = input.annualRatePct + input.shock.rateChangeBps / 100;
  nonNegative("stressed annualRatePct", stressedRate);

  const baseline = downsideState(input);
  const stressed = downsideState({
    propertyValue: input.propertyValue * (1 + input.shock.propertyValueChangePct / 100),
    loanBalance: input.loanBalance,
    monthlyGrossRent: input.monthlyGrossRent * (1 + input.shock.rentChangePct / 100),
    vacancyPct: stressedVacancy,
    annualOperatingExpenses: input.annualOperatingExpenses
      * (1 + input.shock.operatingExpenseChangePct / 100),
    annualRatePct: stressedRate,
    remainingTermMonths: input.remainingTermMonths,
  });
  const breaches: PropertyDownsideResult["breaches"] = [];
  if (stressed.equity < 0) breaches.push("negative_equity");
  if (stressed.monthlyCashFlow < 0) breaches.push("negative_cash_flow");
  if (stressed.dscr !== null && stressed.dscr < 1) breaches.push("dscr_below_one");

  return {
    baseline,
    stressed,
    equityChange: stressed.equity - baseline.equity,
    monthlyCashFlowChange: stressed.monthlyCashFlow - baseline.monthlyCashFlow,
    breaches,
  };
}
