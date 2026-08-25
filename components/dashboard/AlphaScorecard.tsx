"use client";
import { useEffect, useMemo, useState } from "react";

const T = {
  surface: "#13151C",
  card: "#1A1D27",
  border: "#252836",
  text: "#ECEDEF",
  textSub: "#9B9EA8",
  muted: "#6B7280",
  green: "#34D399",
  red: "#F87171",
  amber: "#FBBF24",
};

type Row = {
  market: "us" | "india";
  book: "paper" | "live";
  book_scope: string;
  benchmark_symbol: string;
  is_primary_snapshot: boolean;
  horizon: string;
  as_of: string;
  excess_return_pct: number | null;
  info_ratio: number | null;
  n_return_days: number;
  confidence: string;
  status: string;
  missing_reason: string | null;
};

function fmtPct(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtNum(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function tone(row: Row) {
  if (row.status !== "ok") return T.muted;
  return (row.excess_return_pct ?? 0) >= 0 ? T.green : T.red;
}

export default function AlphaScorecard({ market }: { market: "us" | "india" }) {
  const [book, setBook] = useState<"paper" | "live">("paper");
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/agents/benchmark-scorecard?market=${market}&book=${book}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "scorecard_load_failed");
      setRows(json.rows ?? []);
    } catch (e: any) {
      setErr(e?.message ?? "scorecard_load_failed");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [market, book]);

  const latestRows = useMemo(() => {
    const byKey = new Map<string, Row>();
    for (const row of rows) {
      const key = `${row.benchmark_symbol}:${row.horizon}`;
      const prev = byKey.get(key);
      if (!prev || row.as_of > prev.as_of) byKey.set(key, row);
    }
    return [...byKey.values()].sort((a, b) => {
      const order = ["1W", "1M", "3M", "YTD", "1Y"];
      return order.indexOf(a.horizon) - order.indexOf(b.horizon);
    });
  }, [rows]);

  async function runRollup() {
    setRunMsg("Running…");
    try {
      const res = await fetch("/api/agents/benchmark-scorecard", { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "rollup_failed");
      setRunMsg(`Updated ${json.rows_written} rows`);
      await load();
    } catch (e: any) {
      setRunMsg(`Error: ${e?.message ?? "rollup_failed"}`);
    }
  }

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", marginBottom: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Benchmark Alpha Scorecard</div>
          <div style={{ fontSize: "12px", color: T.textSub, marginTop: "4px" }}>{market.toUpperCase()} · {book === "paper" ? "paper book" : "live book"} · enabled benchmarks</div>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {(["paper", "live"] as const).map((b) => (
            <button key={b} onClick={() => setBook(b)} style={{ background: book === b ? T.card : "transparent", color: T.text, border: `1px solid ${book === b ? T.textSub : T.border}`, borderRadius: "6px", padding: "6px 10px", cursor: "pointer", fontSize: "12px" }}>
              {b}
            </button>
          ))}
          <button onClick={runRollup} style={{ background: T.card, color: T.text, border: `1px solid ${T.border}`, borderRadius: "6px", padding: "6px 10px", cursor: "pointer", fontSize: "12px" }}>
            Run
          </button>
        </div>
      </div>

      {runMsg && <div style={{ color: runMsg.startsWith("Error") ? T.red : T.green, fontSize: "12px", marginBottom: "10px" }}>{runMsg}</div>}
      {loading ? (
        <div style={{ color: T.muted, fontSize: "12px", padding: "18px 0" }}>Loading alpha scorecard…</div>
      ) : err ? (
        <div style={{ color: T.red, fontSize: "12px", padding: "18px 0" }}>Scorecard unavailable: {err}</div>
      ) : latestRows.length === 0 ? (
        <div style={{ color: T.muted, fontSize: "12px", padding: "18px 0" }}>No scorecard rows yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", fontVariantNumeric: "tabular-nums" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Window", "Benchmark", "Excess", "Info ratio", "n", "Confidence", "Status"].map((h) => (
                  <th key={h} style={{ textAlign: "left", color: T.muted, fontWeight: 500, padding: "7px 8px", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {latestRows.map((row) => (
                <tr key={`${row.benchmark_symbol}-${row.horizon}`} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ padding: "8px", color: T.text }}>{row.horizon}</td>
                  <td style={{ padding: "8px", color: T.textSub }}>{row.benchmark_symbol}{row.is_primary_snapshot ? " · primary" : ""}</td>
                  <td style={{ padding: "8px", color: tone(row), fontWeight: 700 }}>{fmtPct(row.excess_return_pct)}</td>
                  <td style={{ padding: "8px", color: row.status === "ok" ? T.text : T.muted }}>{fmtNum(row.info_ratio)}</td>
                  <td style={{ padding: "8px", color: T.textSub }}>{row.n_return_days}</td>
                  <td style={{ padding: "8px", color: row.confidence === "high" || row.confidence === "medium" ? T.green : row.confidence === "low" ? T.amber : T.muted }}>{row.confidence}</td>
                  <td style={{ padding: "8px", color: row.status === "ok" ? T.green : T.muted, maxWidth: "260px" }} title={row.missing_reason ?? ""}>
                    {row.status.replace(/_/g, " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
