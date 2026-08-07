import { describe, expect, it } from "vitest";
import {
  buildAmortizationSchedule,
  calculateMortgage,
  evaluateBuyVsRent,
  evaluatePropertyDownside,
  evaluateRateShock,
  evaluateRefinance,
  evaluateRentalEconomics,
} from "@/lib/property/scenarios";

describe("property scenario engine", () => {
  it("calculates a standard mortgage and fully amortizes the balance", () => {
    const summary = calculateMortgage({ principal: 100_000, annualRatePct: 6, termMonths: 360 });
    const schedule = buildAmortizationSchedule({ principal: 100_000, annualRatePct: 6, termMonths: 360 });

    expect(summary.monthlyPayment).toBeCloseTo(599.55, 2);
    expect(summary.totalInterest).toBeCloseTo(115_838.19, 1);
    expect(schedule).toHaveLength(360);
    expect(schedule[0].interest).toBeCloseTo(500, 8);
    expect(schedule[359].endingBalance).toBe(0);
    expect(schedule.reduce((sum, row) => sum + row.principal, 0)).toBeCloseTo(100_000, 6);
  });

  it("handles a zero-rate mortgage without division errors", () => {
    const result = calculateMortgage({ principal: 120_000, annualRatePct: 0, termMonths: 120 });
    expect(result).toEqual({ monthlyPayment: 1_000, totalPayment: 120_000, totalInterest: 0 });
  });

  it("values refinancing across both complete remaining loan streams", () => {
    const result = evaluateRefinance({
      balance: 300_000,
      currentAnnualRatePct: 7,
      currentRemainingMonths: 300,
      newAnnualRatePct: 5.5,
      newTermMonths: 300,
      closingCosts: 6_000,
      annualDiscountRatePct: 4,
    });

    expect(result.newMonthlyPayment).toBeLessThan(result.currentMonthlyPayment);
    expect(result.breakevenMonth).not.toBeNull();
    expect(result.breakevenMonth!).toBeGreaterThan(0);
    expect(result.npvBenefit).toBeGreaterThan(0);
    expect(result.isNpvPositive).toBe(true);
  });

  it("does not mistake a longer refinance term for free savings", () => {
    const result = evaluateRefinance({
      balance: 100_000,
      currentAnnualRatePct: 4,
      currentRemainingMonths: 60,
      newAnnualRatePct: 4,
      newTermMonths: 360,
      closingCosts: 2_000,
      annualDiscountRatePct: 0,
    });

    expect(result.initialMonthlySavings).toBeGreaterThan(0);
    expect(result.breakevenMonth).toBeNull();
    expect(result.terminalUndiscountedBenefit).toBeLessThan(0);
    expect(result.npvBenefit).toBeLessThan(0);
    expect(result.isNpvPositive).toBe(false);
  });

  it("measures HELOC interest-only and LAP amortizing rate shocks", () => {
    const heloc = evaluateRateShock({
      instrument: "heloc",
      balance: 120_000,
      currentAnnualRatePct: 8,
      shockedAnnualRatePct: 10,
      repaymentMode: "interest_only",
    });
    const lap = evaluateRateShock({
      instrument: "lap",
      balance: 5_000_000,
      currentAnnualRatePct: 9,
      shockedAnnualRatePct: 11,
      repaymentMode: "amortizing",
      remainingTermMonths: 180,
    });

    expect(heloc.currentMonthlyPayment).toBe(800);
    expect(heloc.shockedMonthlyPayment).toBe(1_000);
    expect(heloc.paymentChangePct).toBeCloseTo(25, 8);
    expect(lap.shockedMonthlyPayment).toBeGreaterThan(lap.currentMonthlyPayment);
  });

  it("computes rental cash flow, cap rate, cash-on-cash return, and DSCR", () => {
    const result = evaluateRentalEconomics({
      purchasePrice: 300_000,
      cashInvested: 75_000,
      monthlyGrossRent: 3_000,
      vacancyPct: 5,
      annualOperatingExpenses: 10_200,
      annualDebtService: 18_000,
    });

    expect(result.effectiveGrossIncome).toBe(34_200);
    expect(result.netOperatingIncome).toBe(24_000);
    expect(result.annualCashFlow).toBe(6_000);
    expect(result.capRatePct).toBe(8);
    expect(result.cashOnCashReturnPct).toBe(8);
    expect(result.dscr).toBeCloseTo(4 / 3, 8);
  });

  it("compares buy and rent using sale proceeds, loan balance, and invested cash differences", () => {
    const result = evaluateBuyVsRent({
      horizonMonths: 120,
      purchasePrice: 500_000,
      downPayment: 100_000,
      mortgageAnnualRatePct: 6.5,
      mortgageTermMonths: 360,
      purchaseCostPct: 2,
      saleCostPct: 6,
      annualAppreciationPct: 3,
      annualPropertyTax: 8_000,
      annualInsurance: 2_000,
      annualMaintenance: 5_000,
      monthlyHoa: 100,
      monthlyRent: 2_600,
      annualRentGrowthPct: 3,
      annualInvestmentReturnPct: 6,
      annualOwnerCostGrowthPct: 2.5,
    });

    expect(Number.isFinite(result.buyAdvantage)).toBe(true);
    expect(result.endingHomeValue).toBeGreaterThan(500_000);
    expect(result.endingMortgageBalance).toBeLessThan(400_000);
    expect(["buy", "rent", "tie"]).toContain(result.financiallyPreferred);
  });

  it("is currency-neutral: scaling money changes amounts, not the decision ratios", () => {
    const usd = evaluateRentalEconomics({
      purchasePrice: 250_000,
      cashInvested: 50_000,
      monthlyGrossRent: 2_500,
      vacancyPct: 4,
      annualOperatingExpenses: 8_800,
      annualDebtService: 15_000,
    });
    const inr = evaluateRentalEconomics({
      purchasePrice: 25_000_000,
      cashInvested: 5_000_000,
      monthlyGrossRent: 250_000,
      vacancyPct: 4,
      annualOperatingExpenses: 880_000,
      annualDebtService: 1_500_000,
    });

    expect(inr.annualCashFlow).toBeCloseTo(usd.annualCashFlow * 100, 6);
    expect(inr.capRatePct).toBeCloseTo(usd.capRatePct, 10);
    expect(inr.cashOnCashReturnPct).toBeCloseTo(usd.cashOnCashReturnPct, 10);
    expect(inr.dscr).toBeCloseTo(usd.dscr!, 10);
  });

  it("applies simultaneous value, rent, vacancy, expense, and rate downside shocks", () => {
    const result = evaluatePropertyDownside({
      propertyValue: 400_000,
      loanBalance: 360_000,
      monthlyGrossRent: 2_800,
      vacancyPct: 5,
      annualOperatingExpenses: 10_000,
      annualRatePct: 6,
      remainingTermMonths: 300,
      shock: {
        propertyValueChangePct: -20,
        rentChangePct: -15,
        vacancyChangePctPoints: 10,
        operatingExpenseChangePct: 20,
        rateChangeBps: 300,
      },
    });

    expect(result.stressed.equity).toBeLessThan(0);
    expect(result.stressed.monthlyCashFlow).toBeLessThan(result.baseline.monthlyCashFlow);
    expect(result.stressed.dscr!).toBeLessThan(result.baseline.dscr!);
    expect(result.breaches).toContain("negative_equity");
    expect(result.breaches).toContain("negative_cash_flow");
    expect(result.breaches).toContain("dscr_below_one");
  });

  it.each([
    () => calculateMortgage({ principal: Number.NaN, annualRatePct: 6, termMonths: 360 }),
    () => calculateMortgage({ principal: 100_000, annualRatePct: Number.POSITIVE_INFINITY, termMonths: 360 }),
    () => calculateMortgage({ principal: 100_000, annualRatePct: 6, termMonths: 360.5 }),
    () => evaluateRentalEconomics({ purchasePrice: 1, cashInvested: 1, monthlyGrossRent: 1, vacancyPct: 101, annualOperatingExpenses: 0, annualDebtService: 0 }),
    () => evaluateRateShock({ instrument: "lap", balance: 1, currentAnnualRatePct: 1, shockedAnnualRatePct: 2, repaymentMode: "amortizing" }),
  ])("rejects non-finite or economically invalid input", (run) => {
    expect(run).toThrow(RangeError);
  });
});
