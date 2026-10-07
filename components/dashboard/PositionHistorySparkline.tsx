"use client";

import type { PositionHistorySeries } from "@/lib/portfolio/position-history";
import { PAPER_BOOK_T } from "@/components/dashboard/PaperBookHeader";

const T = PAPER_BOOK_T;

const WIDTH = 300;
const HEIGHT = 76;
const LEFT = 34;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 17;

function shortDate(value: string | null): string {
  if (!value) return "—";
  return value.slice(5);
}

function sampleForDisplay<T extends { returnPctFromFirstMark: number }>(points: T[]): number[] {
  if (points.length <= 120) return points.map((_, index) => index);
  const keep = new Set<number>([0, points.length - 1]);
  const bucketCount = 60;
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor(bucket * points.length / bucketCount);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * points.length / bucketCount));
    let minIndex = start;
    let maxIndex = start;
    for (let i = start + 1; i < end; i++) {
      if (points[i].returnPctFromFirstMark < points[minIndex].returnPctFromFirstMark) minIndex = i;
      if (points[i].returnPctFromFirstMark > points[maxIndex].returnPctFromFirstMark) maxIndex = i;
    }
    keep.add(minIndex);
    keep.add(maxIndex);
    keep.add(Math.min(end - 1, points.length - 1));
  }
  return [...keep].sort((a, b) => a - b);
}

export default function PositionHistorySparkline({
  series,
  loading,
  currency,
}: {
  series?: PositionHistorySeries;
  loading?: boolean;
  currency: string;
}) {
  const points = series?.points ?? [];
  const displayIndices = sampleForDisplay(points);
  const latest = points.at(-1);
  const baseStatusText = loading
    ? "Loading recorded marks…"
    : series?.status === "ready"
      ? `Since first recorded mark · as of ${series.asOf}`
        : series?.status === "insufficient_history"
          ? `One recorded mark · as of ${series.asOf}; more history needed`
          : "No recorded position-mark history yet";
  const statusText = series?.truncated ? `${baseStatusText} · recent window capped` : baseStatusText;

  if (points.length < 2) {
    return (
      <div style={{ marginTop: "10px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ fontSize: "10px", color: T.textSub, marginBottom: "4px" }}>PRICE PATH</div>
        <div style={{ height: "44px", display: "flex", alignItems: "center", color: T.muted, fontSize: "10px" }}>
          {statusText}
        </div>
      </div>
    );
  }

  const values = points.map(p => p.returnPctFromFirstMark).filter(Number.isFinite);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = Math.max(high - low, 0.25);
  const padding = span * 0.12;
  const minY = low - padding;
  const maxY = high + padding;
  const innerWidth = WIDTH - LEFT - RIGHT;
  const innerHeight = HEIGHT - TOP - BOTTOM;
  const xy = displayIndices.map(sourceIndex => ({
    sourceIndex,
    p: points[sourceIndex],
  })).map(({ sourceIndex, p }) => ({
    ...p,
    x: LEFT + (points.length === 1 ? 0 : sourceIndex / (points.length - 1)) * innerWidth,
    y: TOP + ((maxY - p.returnPctFromFirstMark) / (maxY - minY)) * innerHeight,
  }));
  const zeroY = TOP + ((maxY - 0) / (maxY - minY)) * innerHeight;
  const color = (latest?.returnPctFromFirstMark ?? 0) >= 0 ? "#34d399" : "#fb7185";
  const formatPct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;

  return (
    <div style={{ marginTop: "10px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px", marginBottom: "2px" }}>
        <span style={{ fontSize: "10px", color: T.textSub, letterSpacing: "0.04em" }}>PRICE PATH · FIRST RECORDED MARK</span>
        <span style={{ fontSize: "10px", color: latest?.stale ? T.amber : color, fontWeight: 700 }}>
          {latest ? formatPct(latest.returnPctFromFirstMark) : "—"}
        </span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${series?.symbol ?? "Position"} price path, ${latest ? formatPct(latest.returnPctFromFirstMark) : "unavailable"} from first recorded mark`} style={{ display: "block", width: "100%", height: "76px", overflow: "visible" }}>
        <line x1={LEFT} x2={WIDTH - RIGHT} y1={zeroY} y2={zeroY} stroke={T.muted} strokeDasharray="3 3" strokeWidth="0.8" />
        <text x="1" y={Math.max(TOP + 5, 12)} fill={T.muted} fontSize="8">{formatPct(maxY)}</text>
        <text x="1" y={zeroY + 3} fill={T.muted} fontSize="8">0%</text>
        <text x="1" y={HEIGHT - BOTTOM + 3} fill={T.muted} fontSize="8">{formatPct(minY)}</text>
        {xy.slice(1).map((point, index) => {
          const prev = xy[index];
          const muted = prev.stale || point.stale;
          return <line key={`${prev.sessionDate}-${point.sessionDate}-${index}`} x1={prev.x} y1={prev.y} x2={point.x} y2={point.y} stroke={muted ? T.muted : color} strokeWidth="1.8" strokeDasharray={muted ? "3 2" : undefined} />;
        })}
        {xy.filter((point, index) => point.stale || index === xy.length - 1 || index === 0).map((point, index) => (
          <circle key={`${point.sessionDate}-${index}`} cx={point.x} cy={point.y} r="2.3" fill={point.stale ? T.amber : color}>
            <title>{`${point.sessionDate}: ${currency}${point.markPrice.toFixed(2)} · ${formatPct(point.returnPctFromFirstMark)} · ${point.stale ? "stale/carry-forward" : point.provenance}`}</title>
          </circle>
        ))}
        <text x={LEFT} y={HEIGHT - 2} fill={T.muted} fontSize="8">{shortDate(points[0]?.sessionDate ?? null)}</text>
        <text x={WIDTH - RIGHT} y={HEIGHT - 2} textAnchor="end" fill={T.muted} fontSize="8">{shortDate(series?.asOf ?? null)}</text>
      </svg>
      <div style={{ fontSize: "9px", color: T.muted, marginTop: "-2px" }}>{statusText}; price change only, not position P&amp;L or split-adjusted return.</div>
    </div>
  );
}
