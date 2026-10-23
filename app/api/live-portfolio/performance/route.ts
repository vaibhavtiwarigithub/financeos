// Compatibility endpoint: one canonical chart contract; never backcast today's
// holdings or put paper history in a live chart. Owner-gated by the shared
// handler's explicit live book scope.
import { NextRequest } from "next/server";
import { GET as performanceSeries } from "@/app/api/portfolio/performance-series/route";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  url.searchParams.set("book", "live");
  return performanceSeries(new NextRequest(url, { headers: req.headers }));
}
