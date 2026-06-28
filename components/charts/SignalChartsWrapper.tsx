"use client";
import { SignalScoreBar, ScoreConvictionScatter } from "./SignalScoreChart";

export default function SignalChartsWrapper({ signals }: { signals: any[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
      <SignalScoreBar signals={signals} />
      <ScoreConvictionScatter signals={signals} />
    </div>
  );
}
