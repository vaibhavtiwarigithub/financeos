export type RobinhoodTransaction = {
  date: string;
  symbol: string;
  action: "buy" | "sell";
  qty: number;
  price: number;
};

const SYMBOL_MAP: Record<string, string> = {
  FB: "META", TWTR: "X", ATVI: "MSFT", VIAC: "PARA", CBS: "PARA",
  DISCA: "WBD", DISCK: "WBD",
};

/** Strict RFC-4180 record parser: quoted commas/newlines and escaped quotes are preserved. */
function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; afterQuote = true; }
      else field += ch;
      continue;
    }

    if (afterQuote && ch !== "," && ch !== "\r" && ch !== "\n" && ch !== " " && ch !== "\t") {
      throw new Error("Malformed CSV: unexpected character after a closing quote.");
    }
    if (ch === '"') {
      if (field.length !== 0 || afterQuote) throw new Error("Malformed CSV: quote inside an unquoted field.");
      quoted = true;
    } else if (ch === ",") {
      record.push(field.trim()); field = ""; afterQuote = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      record.push(field.trim());
      if (record.some((cell) => cell !== "")) records.push(record);
      record = []; field = ""; afterQuote = false;
    } else if (afterQuote && (ch === " " || ch === "\t")) {
      // Permit harmless whitespace between a quoted cell and its delimiter.
    } else {
      field += ch;
    }
  }

  if (quoted) throw new Error("Malformed CSV: unterminated quoted field.");
  if (field.length || record.length || afterQuote) {
    record.push(field.trim());
    if (record.some((cell) => cell !== "")) records.push(record);
  }
  return records;
}

function dateOnly(value: string): string | null {
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$)/.exec(v);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  const parts = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : us
    ? [Number(us[3]), Number(us[1]), Number(us[2])] : null;
  if (!parts) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`
    : null;
}

/** Parse Robinhood's equity activity export without silently truncating valid CSV records. */
export function parseRobinhoodCSV(text: string): RobinhoodTransaction[] {
  const records = parseCsv(text);
  if (records.length < 2) return [];
  const header = records[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "_"));
  const findColumn = (names: string[]) => names.map((name) => header.indexOf(name)).find((i) => i >= 0) ?? -1;
  const dateIdx = findColumn(["activity_date", "date", "process_date"]);
  const symbolIdx = findColumn(["instrument", "symbol"]);
  const transIdx = findColumn(["trans_code", "type", "transaction_type"]);
  const qtyIdx = findColumn(["quantity", "qty"]);
  const priceIdx = findColumn(["price"]);
  if ([dateIdx, symbolIdx, transIdx, qtyIdx, priceIdx].some((i) => i < 0)) {
    throw new Error("CSV is missing a required trade column (date, symbol, type, quantity, or price).");
  }

  const rows: RobinhoodTransaction[] = [];
  for (const [index, cells] of records.slice(1).entries()) {
    const trans = cells[transIdx]?.trim().toUpperCase() ?? "";
    if (!["BUY", "B", "SHR", "SELL", "S"].includes(trans)) continue;
    const rawSymbol = cells[symbolIdx]?.trim().toUpperCase() ?? "";
    const date = dateOnly(cells[dateIdx] ?? "");
    const qty = Number((cells[qtyIdx] ?? "").replace(/[$,]/g, ""));
    const price = Number((cells[priceIdx] ?? "").replace(/[$,]/g, ""));
    if (!rawSymbol || !date || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
      throw new Error(`CSV trade row ${index + 2} has an invalid date, symbol, quantity, or price.`);
    }
    rows.push({
      date,
      symbol: SYMBOL_MAP[rawSymbol] ?? rawSymbol,
      action: ["BUY", "B", "SHR"].includes(trans) ? "buy" : "sell",
      qty,
      price,
    });
  }
  return rows;
}
