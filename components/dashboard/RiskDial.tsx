"use client";

// The risk dial, drawn as SVG for the page.
//
// Same numbers as the email's segmented bar (both read lib/risk/risk-gauge.ts),
// different rendering: Gmail strips inline SVG, so the email cannot use this.
//
// Direction matters and is the opposite of a Seeking Alpha rating dial. Theirs
// runs Strong Sell → Strong Buy, so green means "buy". This one measures how
// much risk is being carried, so green means "less concentrated, less leveraged
// to the market". It describes a portfolio; it does not rate one.

import React from "react";
import { BANDS, BAND_COLORS, bandFor, clampScore, needleAngle } from "@/lib/risk/risk-gauge";

export function RiskDial({ score, size = 220 }: { score: number; size?: number }) {
  const s = clampScore(score);
  const band = bandFor(s);
  const r = 88;
  const cx = 110;
  const cy = 104;
  const stroke = 20;

  // Four equal 45° arcs across the 180° sweep, drawn left (low) to right (high).
  const arc = (from: number, to: number) => {
    const pt = (deg: number) => {
      const rad = ((deg - 180) * Math.PI) / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  };

  const angle = needleAngle(s);
  const needleRad = ((angle - 90) * Math.PI) / 180;
  const nx = cx + (r - 26) * Math.cos(needleRad);
  const ny = cy + (r - 26) * Math.sin(needleRad);

  return (
    <svg viewBox="0 0 220 128" width={size} height={(size * 128) / 220} role="img"
         aria-label={`Risk score ${Math.round(s)} out of 100, ${band}`}>
      {BANDS.map((b, i) => (
        <path key={b.band} d={arc(i * 45, (i + 1) * 45)} fill="none"
              stroke={BAND_COLORS[b.band]} strokeWidth={stroke}
              opacity={b.band === band ? 1 : 0.28} strokeLinecap="butt" />
      ))}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#E2E8F0" strokeWidth={3} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={6} fill="#E2E8F0" />
      <text x={cx} y={cy - 26} textAnchor="middle" fill={BAND_COLORS[band]}
            style={{ font: "700 30px system-ui, sans-serif" }}>{Math.round(s)}</text>
      <text x={cx} y={cy - 8} textAnchor="middle" fill="#9B9EA8"
            style={{ font: "500 11px system-ui, sans-serif" }}>{band} risk</text>
    </svg>
  );
}

/** A compact score-over-time line. No axis furniture — it answers "up or down?". */
export function ScoreSparkline({
  points, width = 320, height = 56,
}: { points: Array<{ riskScore: number; asOfDate: string | null }>; width?: number; height?: number }) {
  if (points.length < 2) return null;
  const xs = points.map((_, i) => (i / (points.length - 1)) * (width - 4) + 2);
  const ys = points.map((p) => height - 4 - (clampScore(p.riskScore) / 100) * (height - 8));
  const d = xs.map((x, i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  const rising = clampScore(last.riskScore) > clampScore(first.riskScore);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
         aria-label={`Risk score over the last ${points.length} readings`}>
      <path d={d} fill="none" stroke={rising ? "#EAB308" : "#22C55E"} strokeWidth={2} strokeLinejoin="round" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={3} fill={rising ? "#EAB308" : "#22C55E"} />
    </svg>
  );
}
