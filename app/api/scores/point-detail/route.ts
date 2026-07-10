import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// Returns the full "why" behind a score point: the per-dimension evidence
// (the actual data points — P/E, ROE, RSI, sentiment %, danger score, etc. —
// that produced each dimension score), the thesis, key risks, catalysts, the
// weights used, and (if a prior packet id is given) the prior run's evidence so
// the caller can narrate what changed per dimension.
//
// Reads research_packets.raw_data, which the research agent stores as:
//   { _scores: { fundamental_score, ..., evidence: { fundamental, technical,
//     sentiment, macro, insider }, dataQuality }, _analyst_score,
//     _profile_weights, _using_champion_weights, ... }
// plus top-level summary / key_risks / catalysts on the packet row.

interface PacketDetail {
  packet_id: string | null;
  analyst_score: number | null;
  summary: string | null;
  key_risks: string[];
  catalysts: string[];
  weights: Record<string, number> | null;
  used_champion_weights: boolean | null;
  scores: Record<string, number | null>;
  evidence: Record<string, unknown>;
  data_quality: Record<string, unknown> | null;
  created_at: string | null;
}

async function loadPacket(svc: any, id: string | null): Promise<PacketDetail | null> {
  if (!id) return null;
  const { data } = await svc.from("research_packets")
    .select("id, symbol, summary, key_risks, catalysts, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, raw_data, created_at")
    .eq("id", id).maybeSingle();
  if (!data) return null;
  const raw = (data as any).raw_data ?? {};
  const s = raw._scores ?? {};
  return {
    packet_id: (data as any).id,
    analyst_score: raw._analyst_score ?? null,
    summary: (data as any).summary ?? null,
    key_risks: Array.isArray((data as any).key_risks) ? (data as any).key_risks : [],
    catalysts: Array.isArray((data as any).catalysts) ? (data as any).catalysts : [],
    weights: raw._profile_weights ?? null,
    used_champion_weights: raw._using_champion_weights ?? null,
    scores: {
      fundamental: (data as any).fundamental_score ?? s.fundamental_score ?? null,
      technical: (data as any).technical_score ?? s.technical_score ?? null,
      sentiment: (data as any).sentiment_score ?? s.sentiment_score ?? null,
      macro: (data as any).macro_score ?? s.macro_score ?? null,
      insider: (data as any).insider_score ?? s.insider_score ?? null,
    },
    evidence: s.evidence ?? {},
    data_quality: s.dataQuality ?? raw._data_quality ?? null,
    created_at: (data as any).created_at ?? null,
  };
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const packetId = req.nextUrl.searchParams.get("packet_id");
  const priorId = req.nextUrl.searchParams.get("prior_packet_id");
  if (!packetId) return NextResponse.json({ detail: null, prior: null, available: false });

  try {
    const svc = createServiceClient();
    const [detail, prior] = await Promise.all([loadPacket(svc, packetId), loadPacket(svc, priorId)]);
    return NextResponse.json({ detail, prior, available: !!detail });
  } catch (err) {
    return NextResponse.json({ detail: null, prior: null, available: false, error: String(err) });
  }
}
