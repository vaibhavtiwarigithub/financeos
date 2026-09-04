// Declared session convention for 24/7 crypto instruments.
//
// Crypto never closes. This constant anchors the daily aggregation boundary —
// the equivalent of equity market close — so candle labels and forward-return
// windows are reproducible. 00:00 UTC is the industry convention for crypto
// daily bars (Binance, Coinbase, Alpha Vantage DIGITAL_CURRENCY_DAILY all use it).
//
// NOT a real market session. Never use America/New_York or Asia/Kolkata logic
// for crypto candles. See features/robinhood-crypto/FEATURE_ARCHITECTURE.md §2.2.
//
// ponytail: single constant; per-coin offsets only if providers actually diverge.

import type { InstrumentFamily } from "@/lib/scoring/instrument-taxonomy";

/** Hour of day (UTC) at which the crypto "daily bar" closes. 0 = midnight UTC. */
export const CRYPTO_SESSION_CUTOFF_UTC = 0;

/** True when this family uses the crypto session convention instead of equity sessions. */
export function isCryptoFamily(family: InstrumentFamily): family is "crypto" {
  return family === "crypto";
}

/**
 * The newest complete crypto "session date" as of `now`.
 *
 * Before midnight UTC: yesterday's UTC date (bar still accumulating).
 * At or after midnight UTC: today's UTC date (bar sealed at the cutoff).
 *
 * Returns YYYY-MM-DD in UTC.
 */
export function cryptoSessionDate(now: Date = new Date()): string {
  const utcHour = now.getUTCHours();
  const d = new Date(now);
  if (utcHour < CRYPTO_SESSION_CUTOFF_UTC) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Filter candles to those whose UTC date is at or before the newest complete
 * crypto session. Drop future dates (provider bug) and the in-progress bar.
 */
export function cryptoCompletedCandles<T extends { date: string }>(
  candles: readonly T[],
  now: Date = new Date(),
): T[] {
  const cutoff = cryptoSessionDate(now);
  return candles.filter((c) => c.date <= cutoff);
}

/**
 * Guard: throws if a crypto family instrument is routed through equity-session
 * logic. Call from any function that applies America/New_York or Asia/Kolkata
 * session boundaries when instrument family is known.
 *
 * ponytail: makes the wrong path loud; not a substitute for using the right path.
 */
export function assertNotCryptoFamily(
  family: InstrumentFamily | undefined,
  callerName: string,
): void {
  if (family === "crypto") {
    throw new Error(
      `${callerName}: family="crypto" must use cryptoCompletedCandles() / cryptoSessionDate(), ` +
        `not America/New_York or Asia/Kolkata equity-session logic. ` +
        `See lib/data/crypto-session.ts.`,
    );
  }
}
