/** Provider spelling only. Keep canonical cache/position/observation IDs intact.
 * Yahoo uses a dash for US share classes; .NS/.BO exchange suffixes stay dots. */
export function yahooChartSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/^([A-Z]{1,5})\.([A-Z])$/, "$1-$2");
}
