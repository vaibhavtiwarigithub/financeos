"use client";
import { useState } from "react";
import { Treemap, ResponsiveContainer } from "recharts";

const T = { card: "#1A1D27", border: "#252836", muted: "#6B7280", text: "#ECEDEF", textSub: "#9B9EA8" };

interface SectorQuote { symbol: string; name: string; price: number; changePct: number; }

function cellColor(pct: number): string {
  const abs = Math.min(Math.abs(pct), 3);
  const intensity = abs / 3;
  if (pct >= 0) {
    const r = Math.round(5 + (52 - 5) * (1 - intensity));
    const g = Math.round(46 + (211 - 46) * intensity);
    const b = Math.round(22 + (153 - 22) * (1 - intensity));
    return `rgb(${r},${g},${b})`;
  } else {
    const r = Math.round(59 + (248 - 59) * intensity);
    const g = Math.round(0 + (113 - 0) * (1 - intensity));
    const b = Math.round(0 + (113 - 0) * (1 - intensity));
    return `rgb(${r},${g},${b})`;
  }
}

function CustomContent(props: any) {
  const { x, y, width, height, name, changePct, symbol, onHover } = props;
  if (width < 20 || height < 20) return null;
  const bg = cellColor(changePct ?? 0);
  const textColor = "#fff";
  return (
    <g
      onMouseEnter={() => onHover?.({ name, symbol, price: props.price, changePct })}
      onMouseLeave={() => onHover?.(null)}
    >
      <rect x={x + 1} y={y + 1} width={width - 2} height={height - 2} fill={bg} rx={4} ry={4} />
      {height > 50 && width > 60 && (
        <text x={x + width / 2} y={y + height / 2 - 8} textAnchor="middle" fill={textColor} fontSize={11} fontWeight={600}>{symbol}</text>
      )}
      {height > 50 && width > 60 && (
        <text x={x + width / 2} y={y + height / 2 + 8} textAnchor="middle" fill={textColor} fontSize={10}>
          {(changePct ?? 0) >= 0 ? "+" : ""}{(changePct ?? 0).toFixed(2)}%
        </text>
      )}
      {height <= 50 && width > 40 && (
        <text x={x + width / 2} y={y + height / 2 + 4} textAnchor="middle" fill={textColor} fontSize={9} fontWeight={600}>{symbol}</text>
      )}
    </g>
  );
}

export default function SectorTreemap({ sectors }: { sectors: SectorQuote[] }) {
  const [hovered, setHovered] = useState<any | null>(null);

  const data = sectors.map(s => ({
    name: s.name,
    symbol: s.symbol,
    price: s.price,
    changePct: s.changePct,
    size: Math.max(Math.abs(s.price), 10),
  }));

  // Custom content factory that includes hover handler
  const renderContent = (props: any) => (
    <CustomContent {...props} onHover={setHovered} />
  );

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Sector Heatmap
        </div>
        {hovered && (
          <div style={{ fontSize: "12px", color: T.textSub }}>
            <span style={{ fontWeight: 700, color: T.text }}>{hovered.name}</span>
            {" · "}${hovered.price?.toFixed(2)}
            {" · "}
            <span style={{ fontWeight: 700, color: (hovered.changePct ?? 0) >= 0 ? "#34D399" : "#F87171" }}>
              {(hovered.changePct ?? 0) >= 0 ? "+" : ""}{(hovered.changePct ?? 0).toFixed(2)}%
            </span>
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
        <span style={{ color: T.muted }}>Hover for details · Size = ETF price</span>
      </div>
    </div>
  );
}
