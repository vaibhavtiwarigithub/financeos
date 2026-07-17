"use client";
import { useState } from "react";
import { Treemap, ResponsiveContainer } from "recharts";
import { cellColor } from "@/lib/markets/sector-color";

const T = { card: "#1A1D27", border: "#252836", muted: "#6B7280", text: "#ECEDEF", textSub: "#9B9EA8" };

interface SectorQuote {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  status?: "ok" | "unavailable";
  reason?: string;
}

// A sector with no usable data must not borrow the colour ramp — a hatched grey
// cell reads as "no data", where a green +0.00% cell would read as "flat".
const NO_DATA_FILL = "#2A2E3B";

// Colour ramp lives in lib/markets/sector-color.ts so its arithmetic is
// unit-tested independently of React/recharts. See sector-color.test.ts.

function CustomContent(props: any) {
  const { x, y, width, height, name, changePct, symbol, status, reason, onHover, onSymbol } = props;
  if (width < 20 || height < 20) return null;
  const unavailable = status === "unavailable" || changePct == null;
  const bg = unavailable ? NO_DATA_FILL : cellColor(changePct);
  const textColor = unavailable ? T.textSub : "#fff";
  return (
    <g
      onMouseEnter={() => onHover?.({ name, symbol, price: props.price, changePct, status, reason })}
      onMouseLeave={() => onHover?.(null)}
      onClick={() => onSymbol?.(symbol)}
      style={onSymbol ? { cursor: "pointer" } : undefined}
    >
      <rect
        x={x + 1}
        y={y + 1}
        width={width - 2}
        height={height - 2}
        fill={bg}
        stroke={unavailable ? T.border : "none"}
        strokeDasharray={unavailable ? "3 3" : undefined}
        rx={4}
        ry={4}
      />
      {height > 50 && width > 60 && (
        <text x={x + width / 2} y={y + height / 2 - 8} textAnchor="middle" fill={textColor} fontSize={11} fontWeight={600}>{symbol}</text>
      )}
      {height > 50 && width > 60 && (
        <text x={x + width / 2} y={y + height / 2 + 8} textAnchor="middle" fill={textColor} fontSize={10}>
          {unavailable ? "no data" : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`}
        </text>
      )}
      {height <= 50 && width > 40 && (
        <text x={x + width / 2} y={y + height / 2 + 4} textAnchor="middle" fill={textColor} fontSize={9} fontWeight={600}>{symbol}</text>
      )}
    </g>
  );
}

export default function SectorTreemap({
  sectors,
  onSymbol,
}: {
  sectors: SectorQuote[];
  onSymbol?: (sym: string) => void;
}) {
  const [hovered, setHovered] = useState<any | null>(null);

  const data = sectors.map(s => ({
    name: s.name,
    symbol: s.symbol,
    price: s.price,
    changePct: s.changePct,
    status: s.status ?? (s.changePct == null ? "unavailable" : "ok"),
    reason: s.reason,
    // Cell AREA is deliberately uniform. It previously encoded the ETF's share
    // price, which is not market cap, index weight, or volume — XLK's cell was
    // ~4x XLU's purely because of share-price convention, implying Technology
    // was "bigger" in a sense the number never carried. Rather than dress up a
    // meaningless quantity, area now encodes nothing and colour carries the one
    // real signal (daily change). Disclosed in the legend below.
    size: 1,
  }));

  // Custom content factory that includes hover + click handlers
  const renderContent = (props: any) => (
    <CustomContent {...props} onHover={setHovered} onSymbol={onSymbol} />
  );

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Sector Heatmap{onSymbol ? " · click to view chart" : ""}
        </div>
        {hovered && (
          <div style={{ fontSize: "12px", color: T.textSub }}>
            <span style={{ fontWeight: 700, color: T.text }}>{hovered.name}</span>
            {hovered.price != null && <>{" · "}${hovered.price.toFixed(2)}</>}
            {" · "}
            {hovered.changePct == null ? (
              <span style={{ fontWeight: 700, color: T.muted }}>
                {hovered.reason ?? "no data"}
              </span>
            ) : (
              <span style={{ fontWeight: 700, color: hovered.changePct >= 0 ? "#34D399" : "#F87171" }}>
                {hovered.changePct >= 0 ? "+" : ""}{hovered.changePct.toFixed(2)}%
              </span>
            )}
          </div>
        )}
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <Treemap data={data} dataKey="size" content={renderContent as any} />
      </ResponsiveContainer>
      <div style={{ marginTop: "10px", display: "flex", gap: "16px", fontSize: "11px", color: T.muted }}>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ width: "12px", height: "12px", background: "#34D399", borderRadius: "2px", display: "inline-block" }} />
          Positive
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ width: "12px", height: "12px", background: "#F87171", borderRadius: "2px", display: "inline-block" }} />
          Negative
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ width: "12px", height: "12px", background: NO_DATA_FILL, border: `1px dashed ${T.border}`, borderRadius: "2px", display: "inline-block" }} />
          No data
        </span>
        <span style={{ color: T.muted }}>Hover for details · Colour = daily change · Size = no meaning (uniform)</span>
      </div>
    </div>
  );
}
