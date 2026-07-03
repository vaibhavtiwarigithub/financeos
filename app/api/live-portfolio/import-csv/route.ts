import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";

// Known symbol renames/mergers
const SYMBOL_MAP: Record<string, string> = {
  "FB": "META", "TWTR": "X", "ATVI": "MSFT", "VIAC": "PARA",
  "CBS": "PARA", "DISCA": "WBD", "DISCK": "WBD", "T": "T",
};

type RobinhoodRow = {
  date: string;
  symbol: string;
  action: "buy" | "sell";
  qty: number;
  price: number;
};

function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  return SYMBOL_MAP[s] ?? s;
}

// Parse Robinhood CSV — handles both old and new export formats
function parseRobinhoodCSV(text: string): RobinhoodRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "_"));

  // Detect column positions
  const col = (names: string[]) => names.map(n => header.indexOf(n)).find(i => i >= 0) ?? -1;
  const dateIdx   = col(["activity_date", "date", "process_date"]);
  const symbolIdx = col(["instrument", "symbol"]);
  const transIdx  = col(["trans_code", "type", "transaction_type"]);
  const qtyIdx    = col(["quantity", "qty"]);
  const priceIdx  = col(["price"]);

  if (dateIdx < 0 || symbolIdx < 0 || transIdx < 0 || qtyIdx < 0 || priceIdx < 0) return [];

  const rows: RobinhoodRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    const trans = cells[transIdx]?.trim().toUpperCase() ?? "";
    // Only keep buy/sell equity transactions
    if (!["BUY", "B", "SELL", "S", "SHR"].includes(trans) && trans !== "SHR") continue;
    const isBuy = ["BUY", "B", "SHR"].includes(trans);
    if (!isBuy && !["SELL", "S"].includes(trans)) continue;

    const rawSymbol = cells[symbolIdx]?.trim();
    if (!rawSymbol || rawSymbol.length === 0) continue;

    const rawDate = cells[dateIdx]?.trim();
    if (!rawDate) continue;
    const parsedDate = new Date(rawDate);
    if (isNaN(parsedDate.getTime())) continue;
    const dateStr = parsedDate.toISOString().slice(0, 10);

    const qty = parseFloat(cells[qtyIdx]?.replace(/,/g, "") ?? "0");
    const price = parseFloat(cells[priceIdx]?.replace(/[$,]/g, "") ?? "0");
    if (qty <= 0 || price <= 0) continue;

    rows.push({
      date: dateStr,
      symbol: normalizeSymbol(rawSymbol),
      action: isBuy ? "buy" : "sell",
      qty,
      price,
    });
  }
  return rows;
}

export async function POST(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const files = formData.getAll("files") as File[];
  if (!files || files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const results: any[] = [];

  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileHash = createHash("sha256").update(buffer).digest("hex");
    const filename = file.name;

    // Duplicate file check
    const { data: existing } = await svc
      .from("uploaded_trade_files")
      .select("id, trade_count")
      .eq("file_hash", fileHash)
      .single();

    if (existing) {
      results.push({ filename, status: "duplicate_file", message: "Already uploaded", trade_count: existing.trade_count });
      continue;
    }

    const text = buffer.toString("utf-8");
    const rows = parseRobinhoodCSV(text);

    if (rows.length === 0) {
      results.push({ filename, status: "parse_error", message: "No valid buy/sell transactions found. Check format." });
      continue;
    }

    // Insert decisions — ON CONFLICT DO NOTHING for transaction-level dedup
    let imported = 0;
    let duplicates = 0;
    const dates = rows.map(r => r.date).sort();

    for (const row of rows) {
      const { error } = await svc.from("trade_decisions").insert({
        source_file: filename,
        symbol: row.symbol,
        action: row.action,
        qty: row.qty,
        exec_price: row.price,
        exec_date: row.date,
        enrichment_status: "pending",
      });
      if (error?.code === "23505") { // unique violation
        duplicates++;
      } else if (!error) {
        imported++;
      }
    }

    // Record the file
    await svc.from("uploaded_trade_files").insert({
      filename,
      file_hash: fileHash,
      trade_count: imported,
      duplicate_count: duplicates,
      date_range_start: dates[0],
      date_range_end: dates[dates.length - 1],
      broker: "robinhood",
    });

    results.push({
      filename,
      status: "ok",
      imported,
      duplicates,
      total_parsed: rows.length,
      date_range: `${dates[0]} to ${dates[dates.length - 1]}`,
    });
  }

  return NextResponse.json({ results });
}
