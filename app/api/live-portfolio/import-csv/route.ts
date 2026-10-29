import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { createHash } from "crypto";
import { parseRobinhoodCSV } from "@/lib/trades/robinhood-csv";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

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
    let rows;
    try {
      rows = parseRobinhoodCSV(text);
    } catch (error) {
      results.push({ filename, status: "parse_error", message: error instanceof Error ? error.message : "Malformed CSV." });
      continue;
    }

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
