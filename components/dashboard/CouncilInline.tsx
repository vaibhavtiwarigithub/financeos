"use client";

import { useEffect, useState } from "react";

// Compact LLM-council (shadow) score for tables that already show the deterministic score. Stored forecasts only,
// one batched read per table. Display only: nothing here influences a trade.

export type CouncilLatest = { decisionTs: string; status: string; median: number | null; deepseek: number | null; claude: number | null; codex: number | null };

export function useCouncilLatest(symbols: string[], market: string): Record<string, CouncilLatest> {
  const [data, setData] = useState<Record<string, CouncilLatest>>({});
  const key = [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(",");
  useEffect(() => {
    if (!key) { setData({}); return; }
    let active = true;
    fetch(`/api/research/council/latest?market=${market}&symbols=${encodeURIComponent(key)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (active) setData(j?.bySymbol ?? {}); })
      .catch(() => { if (active) setData({}); });
    return () => { active = false; };
  }, [key, market]);
  return data;
}

const r = (v: number | null) => (v == null ? "–" : String(Math.round(v)));

export function CouncilInline({ latest }: { latest: CouncilLatest | undefined }) {
  if (!latest) return null;
  const title = `LLM council (shadow) as of ${latest.decisionTs}: DeepSeek ${r(latest.deepseek)} · Claude ${r(latest.claude)} · Codex ${r(latest.codex)}${latest.median == null ? " · median not available (a member score is missing)" : ""}. Display only; no trade uses it.`;
  return (
    <div title={title} style={{ fontSize: 11, color: "#ec4899", marginTop: 3, whiteSpace: "nowrap" }}>
      Council {r(latest.median)} <span style={{ opacity: 0.7 }}>({r(latest.deepseek)}·{r(latest.claude)}·{r(latest.codex)})</span>
    </div>
  );
}
