"use client";

import type { PositionActivitySeries } from "@/lib/portfolio/position-history";
import { PAPER_BOOK_T } from "@/components/dashboard/PaperBookHeader";

const T = PAPER_BOOK_T;
const WIDTH = 300;
const HEIGHT = 78;
const LEFT = 34;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 17;

function shortDate(value: string | null | undefined): string {
  return value ? value.slice(5, 10) : "—";
}

export default function PositionActivityChart({
  activity,
  currentQty,
  currency,
  loading,
}: {
  activity?: PositionActivitySeries;
  currentQty: number;
  currency: string;
  loading?: boolean;
}) {
  const events = activity?.status === "ready" ? activity.events : [];
  const unavailable = activity?.status !== "ready";
  const title = loading
    ? "Loading the current position's trade history…"
    : activity?.status === "reconciliation_mismatch"
    ? "Activity hidden · fills do not reconcile to current shares"
    : activity?.status === "unavailable"
      ? "Activity unavailable · exact current-position trade history is incomplete"
      : "Position size reconstructed from paper fills";

  return (
    <div style={{ marginTop: "8px", paddingTop: "7px", borderTop: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "baseline", marginBottom: "2px" }}>
        <span style={{ fontSize: "10px", color: T.textSub, letterSpacing: "0.04em" }}>POSITION LADDER · SHARES</span>
        <span style={{ fontSize: "10px", color: T.muted, fontWeight: 700 }}>{currentQty.toLocaleString(undefined, { maximumFractionDigits: 6 })} held</span>
      </div>
      {unavailable ? (
        <div style={{ height: "48px", display: "flex", alignItems: "center", color: activity?.status === "reconciliation_mismatch" ? T.amber : T.muted, fontSize: "10px" }}>
          {title}
        </div>
      ) : (
        <>
          {(() => {
            const maxQty = Math.max(currentQty, ...events.map(event => event.quantityAfter), 1);
            const innerWidth = WIDTH - LEFT - RIGHT;
            const innerHeight = HEIGHT - TOP - BOTTOM;
            const firstAt = Date.parse(events[0].at);
            const lastAt = Date.parse(events.at(-1)!.at);
            const timeSpan = Math.max(1, lastAt - firstAt);
            const xy = events.map(event => ({
              event,
              x: LEFT + ((Date.parse(event.at) - firstAt) / timeSpan) * innerWidth,
              y: TOP + ((maxQty - event.quantityAfter) / maxQty) * innerHeight,
            }));
            const zeroY = TOP + innerHeight;
            const formatQty = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 4 });
            const formatMoney = (value: number) => `${currency}${value.toFixed(2)}`;
            return (
              <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Position share ladder: ${events.length} reconciled buy and sell events, ${formatQty(currentQty)} shares currently held`} style={{ display: "block", width: "100%", height: "78px", overflow: "visible" }}>
                <line x1={LEFT} x2={WIDTH - RIGHT} y1={zeroY} y2={zeroY} stroke={T.muted} strokeDasharray="3 3" strokeWidth="0.8" />
                <text x="1" y={TOP + 4} fill={T.muted} fontSize="8">{formatQty(maxQty)}</text>
                <text x="14" y={zeroY + 3} fill={T.muted} fontSize="8">0</text>
                {xy.slice(1).map((point, index) => {
                  const prev = xy[index];
                  return <g key={`${point.event.at}-${index}`}>
                    <line x1={prev.x} y1={prev.y} x2={point.x} y2={prev.y} stroke={T.textSub} strokeWidth="1.5" />
                    <line x1={point.x} y1={prev.y} x2={point.x} y2={point.y} stroke={point.event.side === "buy" ? T.green : T.red} strokeWidth="1.5" />
                  </g>;
                })}
                {xy.map((point, index) => {
                  const color = point.event.side === "buy" ? T.green : T.red;
                  const label = `${point.event.side.toUpperCase()} ${formatQty(point.event.quantity)} shares @ ${formatMoney(point.event.fillPrice)} · value ${formatMoney(point.event.notional)} · now ${formatQty(point.event.quantityAfter)} shares${point.event.reason ? ` · ${point.event.reason}` : ""}`;
                  return <circle key={`${point.event.at}-${point.event.side}-${index}`} cx={point.x} cy={point.y} r="3" fill={color} stroke={T.surface} strokeWidth="1">
                    <title>{`${new Date(point.event.at).toLocaleString()}: ${label}`}</title>
                  </circle>;
                })}
                <text x={LEFT} y={HEIGHT - 2} fill={T.muted} fontSize="8">{shortDate(events[0]?.at)}</text>
                <text x={WIDTH - RIGHT} y={HEIGHT - 2} textAnchor="end" fill={T.muted} fontSize="8">{shortDate(events.at(-1)?.at)}</text>
              </svg>
            );
          })()}
          <div style={{ fontSize: "9px", color: T.muted, marginTop: "-2px" }} title={title}>
            Green = buy/add · red = sold quantity. Hover a dot for fill price and traded value; the step line is shares held, not P&amp;L.
          </div>
        </>
      )}
    </div>
  );
}
