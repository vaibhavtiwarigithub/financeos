import { readFile } from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { findSystemReferenceDocument } from "@/lib/system-reference/registry";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ document: string }> }) {
  const gate = await requireOwner();
  if (gate) return gate;

  const { document: documentId } = await params;
  const document = findSystemReferenceDocument(documentId);
  if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  // `document.path` only comes from the fixed registry above. Do not construct a
  // path from the request, otherwise this route becomes a repository-file reader.
  try {
    const content = await readFile(path.join(process.cwd(), document.path), "utf8");
    const download = request.nextUrl.searchParams.get("download") === "1";
    const filename = document.path.split("/").at(-1) ?? "kairos-reference.md";
    return new NextResponse(content, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename=\"${filename}\"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Reference document is unavailable in this deployment" }, { status: 503 });
  }
}
