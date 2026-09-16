// Pure exit-decision logic for the Stage 3 crypto paper book
// (app/api/agents/crypto-position-monitor/route.ts). Mechanical only: stop /
// target. Crypto trades continuously, but the first paper implementation uses
// daily OHLC bars. A close-only check misses a stop or target touched intraday;
// when a bar touches both, use the adverse (stop) outcome rather than inventing
// an intrabar path. There is deliberately no clock exit: time alone is not
// evidence that a thesis failed.
export function decideCryptoExit(input: {
  closePrice: number;
  lowPrice: number;
  highPrice: number;
  stopLoss: number | null;
  priceTarget: number | null;
}): "stop" | "target" | null {
  const { lowPrice, highPrice, stopLoss, priceTarget } = input;
  if (stopLoss != null && lowPrice <= stopLoss) return "stop";
  if (priceTarget != null && highPrice >= priceTarget) return "target";
  return null;
}
