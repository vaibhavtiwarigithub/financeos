// India index-ETF sleeve SHADOW (measure-only). Computes the NAV the India paper book WOULD have had if a fixed share w of capital sat in
// NIFTYBEES.NS (daily-rebalanced), alongside the real book. No orders, no capital moved, nothing reads it for trading.
// Why shadow first: features/india-index-etf-sleeve/FEATURE_ARCHITECTURE.md (the only evidence so far argues against carving out capital).

export const SLEEVE_WEIGHTS = [0.1, 0.2, 0.3] as const;
export const SLEEVE_METHOD = "daily_rebalanced_v1";
export const MIN_SESSIONS_FOR_VERDICT = 60;

export interface BookNav { date: string; nav: number }
export interface SleeveRow { as_of_date: string; weight: number; blended_nav: number; book_nav: number; etf_close: number }

/**
 * Extend a blended NAV path forward. `prior` is the last stored row for this weight (or null to seed at the first book date with
 * blended NAV = book NAV). Each later session compounds w * ETF return + (1 - w) * book return between consecutive BOOK sessions.
 *
 * ETF closes must match the book session date EXACTLY. Bridging a missing day with the previous close would record a zero ETF return,
 * and the table is append-only, so a premature bridge would be permanent (Yahoo's latest daily bar for an ETF can carry a null close
 * until the next day). The chain therefore stops at the first session without an exact ETF close and resumes on a later run.
 */
export function extendBlend(
  book: readonly BookNav[], etfCloses: ReadonlyMap<string, number>, weight: number, prior: SleeveRow | null,
): SleeveRow[] {
  const etf = (date: string): number | null => {
    const v = etfCloses.get(date);
    return v != null && Number.isFinite(v) && v > 0 ? v : null;
  };
  const days = [...book].filter((b) => Number.isFinite(b.nav) && b.nav > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out: SleeveRow[] = [];
  let prevIdx: number;
  let blended: number;
  let prevEtf: number;
  if (prior) {
    prevIdx = days.findIndex((d) => d.date === prior.as_of_date);
    if (prevIdx < 0) return out;
    blended = prior.blended_nav;
    prevEtf = prior.etf_close;
  } else {
    if (!days.length) return out;
    const first = days[0];
    const etf0 = etf(first.date);
    if (etf0 == null) return out;
    out.push({ as_of_date: first.date, weight, blended_nav: first.nav, book_nav: first.nav, etf_close: etf0 });
    prevIdx = 0;
    blended = first.nav;
    prevEtf = etf0;
  }
  for (let i = prevIdx + 1; i < days.length; i++) {
    const curEtf = etf(days[i].date);
    if (curEtf == null) break;
    const rBook = days[i].nav / days[i - 1].nav - 1;
    const rEtf = curEtf / prevEtf - 1;
    blended *= 1 + weight * rEtf + (1 - weight) * rBook;
    out.push({ as_of_date: days[i].date, weight, blended_nav: blended, book_nav: days[i].nav, etf_close: curEtf });
    prevEtf = curEtf;
  }
  return out;
}

export interface SleeveMetrics {
  sessions: number;
  totalReturnPct: number;
  annVolPct: number;
  maxDrawdownPct: number;
  returnPerDrawdown: number | null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };

export function pathMetrics(navs: readonly number[]): SleeveMetrics | null {
  if (navs.length < 3) return null;
  const rets = navs.slice(1).map((v, i) => v / navs[i] - 1);
  let peak = navs[0], maxDd = 0;
  for (const v of navs) { peak = Math.max(peak, v); maxDd = Math.min(maxDd, v / peak - 1); }
  const total = navs[navs.length - 1] / navs[0] - 1;
  return {
    sessions: rets.length, totalReturnPct: total * 100, annVolPct: sd(rets) * Math.sqrt(252) * 100, maxDrawdownPct: maxDd * 100,
    returnPerDrawdown: maxDd < 0 ? total / Math.abs(maxDd) : null,
  };
}

export interface BookVsEtf {
  sessions: number;
  beta: number | null;
  correlation: number | null;
  upCapturePct: number | null; // mean book return / mean ETF return on ETF-up days
  downCapturePct: number | null;
  upDays: number;
  downDays: number;
  etfTotalReturnPct: number;
  trackingErrorAnnPct: number | null; // sd of (book - etf) daily, annualized
}

/** How the REAL book moves against the ETF, from the same stored rows (weight rows share book_nav and etf_close). */
export function bookVsEtf(rows: ReadonlyArray<Pick<SleeveRow, "as_of_date" | "book_nav" | "etf_close">>): BookVsEtf | null {
  const r = [...rows].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  if (r.length < 3) return null;
  const book = r.slice(1).map((x, i) => x.book_nav / r[i].book_nav - 1);
  const etf = r.slice(1).map((x, i) => x.etf_close / r[i].etf_close - 1);
  const mb = mean(book), me = mean(etf);
  const cov = book.reduce((s, b, i) => s + (b - mb) * (etf[i] - me), 0) / (book.length - 1);
  const varE = sd(etf) ** 2;
  const up = book.map((b, i) => [b, etf[i]] as const).filter(([, e]) => e > 0);
  const dn = book.map((b, i) => [b, etf[i]] as const).filter(([, e]) => e < 0);
  const cap = (xs: ReadonlyArray<readonly [number, number]>) => xs.length ? (mean(xs.map(([b]) => b)) / mean(xs.map(([, e]) => e))) * 100 : null;
  const diff = book.map((b, i) => b - etf[i]);
  return {
    sessions: book.length, beta: varE > 0 ? cov / varE : null,
    correlation: varE > 0 && sd(book) > 0 ? cov / (sd(book) * sd(etf)) : null,
    upCapturePct: cap(up), downCapturePct: cap(dn), upDays: up.length, downDays: dn.length,
    etfTotalReturnPct: (r[r.length - 1].etf_close / r[0].etf_close - 1) * 100,
    trackingErrorAnnPct: sd(diff) * Math.sqrt(252) * 100,
  };
}

/** Evidence gate only; this module never recommends allocating capital. The owner decides, using these facts. */
export function sleeveEvidenceState(sessions: number, etfTotalReturnPct: number, upDays: number, downDays: number): { state: "collecting" | "one_regime" | "measured"; text: string } {
  if (sessions < MIN_SESSIONS_FOR_VERDICT) return { state: "collecting", text: `${sessions} of ${MIN_SESSIONS_FOR_VERDICT} sessions needed before the comparison is read.` };
  if (upDays < 15 || downDays < 15 || Math.abs(etfTotalReturnPct) < 3 && Math.min(upDays, downDays) < 20) {
    return { state: "one_regime", text: "Enough sessions, but the market has not gone through both clear up and down phases; do not read a rising/falling-market conclusion into it." };
  }
  return { state: "measured", text: "Enough sessions with both up and down days. Compare return, volatility and drawdown by sleeve weight; allocation remains an owner decision." };
}
