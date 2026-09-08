/**
 * Splits an existing fixed-rate loan's full amortization schedule (from
 * lib/property/scenarios.ts, not reimplemented here) into what's already
 * been paid and what's left, as of today or a given date.
 */
import { buildAmortizationSchedule, type AmortizationRow } from "@/lib/property/scenarios";

export type AmortizationSummaryInput = {
  originalPrincipal: number;
  annualRatePct: number;
  originalTermMonths: number;
  /** ISO yyyy-mm-dd loan origination date. */
  startDate: string;
  /** ISO yyyy-mm-dd; defaults to today. */
  asOfDate?: string;
};

export type AmortizationTotals = { principal: number; interest: number; payments: number };

export type AmortizationSummary = {
  elapsedMonths: number;
  remainingMonths: number;
  currentBalance: number;
  paidToDate: AmortizationTotals;
  remaining: AmortizationTotals;
};

/** Whole calendar months between two ISO dates, floored, never negative. */
export function monthsElapsed(startDate: string, asOfDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(asOf.getTime())) {
    throw new RangeError("startDate and asOfDate must be valid ISO dates");
  }
  let months = (asOf.getUTCFullYear() - start.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - start.getUTCMonth());
  if (asOf.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function totals(rows: AmortizationRow[]): AmortizationTotals {
  return rows.reduce(
    (acc, row) => ({ principal: acc.principal + row.principal, interest: acc.interest + row.interest, payments: acc.payments + row.payment }),
    { principal: 0, interest: 0, payments: 0 },
  );
}

export function summarizeAmortization(input: AmortizationSummaryInput): AmortizationSummary {
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const schedule = buildAmortizationSchedule({
    principal: input.originalPrincipal,
    annualRatePct: input.annualRatePct,
    termMonths: input.originalTermMonths,
  });
  // A loan whose original term has already elapsed is paid off, not
  // extrapolated past the end of its own schedule.
  const elapsedMonths = Math.min(monthsElapsed(input.startDate, asOfDate), input.originalTermMonths);
  const paidRows = schedule.slice(0, elapsedMonths);
  const remainingRows = schedule.slice(elapsedMonths);
  return {
    elapsedMonths,
    remainingMonths: input.originalTermMonths - elapsedMonths,
    currentBalance: paidRows.length ? paidRows[paidRows.length - 1].endingBalance : input.originalPrincipal,
    paidToDate: totals(paidRows),
    remaining: totals(remainingRows),
  };
}
