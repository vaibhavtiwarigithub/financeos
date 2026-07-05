"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PageHeader from "./PageHeader";
import { useMarket, CURRENCY } from "@/lib/market-context";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", red: "#F87171",
  greenBg: "#052E16", amberBg: "#2D1B00", redBg: "#3B0000",
};

interface Strategy { id: string; name: string; icon: string; tagline: string; regimes: string[] }

interface ScanResult {
  symbol: string;
  rsi: number | null;
  price: number | null;
  ema50: number | null;
  price_above_ma50: boolean | null;
  fundamental_score: number;
  technical_score: number;
  combined_score: number;
  fundamentals: Record<string, any>;
  passes_filters: boolean;
  filter_notes: string[];
}

interface ScanResponse {
  strategy: { id: string; name: string } | null;
  total_scanned: number;
  passing: number;
  results: ScanResult[];
  data_sources: { fundamentals: string; technicals: string };
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ position: "relative", height: "4px", background: T.border, borderRadius: "2px", marginTop: "3px" }}>
      <div style={{ position: "absolute", left: 0, width: `${value}%`, height: "100%", background: color, borderRadius: "2px" }} />
    </div>
  );
}

export default function ScannerPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initStrategy = searchParams.get("strategy") ?? "";
  const { market } = useMarket();
  const isIndia = market === "india";
  const ccy = CURRENCY[market] ?? "$";

  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState(initStrategy);
  const [manualSymbols, setManualSymbols] = useState("");
  const [rsiMin, setRsiMin] = useState("");
  const [rsiMax, setRsiMax] = useState("");
  const [aboveMa50, setAboveMa50] = useState<"any" | "yes" | "no">("any");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

  const loadStrategies = useCallback(async () => {
    try {
      const res = await fetch("/api/agents/research/scan");
      if (res.ok) { const d = await res.json(); setStrategies(d.strategies ?? []); }
    } catch {}
  }, []);

  useEffect(() => { loadStrategies(); }, [loadStrategies]);

  async function runScan() {
    setScanning(true);
    setError("");
    setResult(null);
    setShowAll(false);
    try {
      const body: any = { limit: 20 };
      if (selectedStrategy) body.strategy_id = selectedStrategy;
      if (manualSymbols.trim()) body.symbols = manualSymbols.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      if (rsiMin)          body.rsi_min = parseFloat(rsiMin);
      if (rsiMax)          body.rsi_max = parseFloat(rsiMax);
      if (aboveMa50 === "yes") body.price_above_ma50 = true;
      if (aboveMa50 === "no")  body.price_above_ma50 = false;

      // India has no free screen API — screen the ~NIFTY-100 universe via the
      // dedicated India route (Yahoo fundamentals + candles, ₹). US path unchanged.
      const endpoint = isIndia ? "/api/scan/india" : "/api/agents/research/scan";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Scan failed");
      setResult(data);
    } catch (e: any) { setError(e.message); }
    finally { setScanning(false); }
  }

  const selStyle: React.CSSProperties = {
    background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px",
    color: T.text, fontSize: "13px", padding: "8px 10px", outline: "none", cursor: "pointer",
  };
  const numInp: React.CSSProperties = {
    width: "70px", background: T.surface, border: `1px solid ${T.border}`,
    borderRadius: "8px", color: T.text, fontSize: "13px", padding: "8px 10px", outline: "none",
  };

  const displayed = result ? (showAll ? result.results : result.results.slice(0, 10)) : [];

  return (
    <div>
      <PageHeader
        title="Strategy Scanner"
        subtitle="Screen stocks matching technical + fundamental conditions"
        cadence="as-needed"
        whatItDoes="Screens stocks using FinancialDatasets for fundamentals (revenue growth, P/E, FCF yield, ROE) and Alpha Vantage for technicals (RSI-14, 50-day EMA). Select a pre-built strategy to auto-load its conditions, or set custom filters. Returns scored candidates ranked by combined fundamental + technical score."
        whatToLookFor={[
          "Passing = meets ALL specified conditions. Non-passing shown below for reference.",
          "Combined score = 50% fundamental + 50% technical. Aim for > 65.",
          "RSI > 60 with price above MA50 = technical momentum confirmed.",
          "Fundamentals need FD API key in vault — check Admin → Vault if showing unavailable.",
          "AV rate limit (free tier) = 5 calls/min. 10 symbols ≈ 30s scan time.",
        ]}
      />

      <div style={{ padding: "0 28px 40px" }}>
        {/* Config */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px 24px", marginBottom: "20px" }}>
          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>Scan Configuration {isIndia && <span style={{ color: T.accent }}>· 🇮🇳 India (₹)</span>}</div>

          {isIndia && (
            <div style={{ background: `${T.accent}10`, border: `1px solid ${T.accent}30`, borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: T.sub }}>
              No free India screen API exists — this scans the <strong style={{ color: T.text }}>~NIFTY-100</strong> universe name-by-name via Yahoo (₹ prices, fundamentals + candles), applying the same filters. Coverage is honestly capped at NIFTY-100, not the full ~2000 NSE. Enter symbols above (e.g. RELIANCE, TCS) to scan specific names.
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: "20px", alignItems: "flex-end", marginBottom: "16px" }}>
            <div>
              <label style={{ fontSize: "12px", color: T.sub, display: "block", marginBottom: "5px" }}>Pre-built Strategy</label>
              <select value={selectedStrategy} onChange={e => setSelectedStrategy(e.target.value)} style={{ ...selStyle, minWidth: "220px" }}>
                <option value="">— Custom conditions —</option>
                {strategies.map(s => (
                  <option key={s.id} value={s.id}>{s.icon} {s.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ fontSize: "12px", color: T.sub, display: "block", marginBottom: "5px" }}>RSI Min</label>
              <input type="number" min={0} max={100} value={rsiMin} onChange={e => setRsiMin(e.target.value)} style={numInp} placeholder="e.g. 60" />
            </div>

            <div>
              <label style={{ fontSize: "12px", color: T.sub, display: "block", marginBottom: "5px" }}>RSI Max</label>
              <input type="number" min={0} max={100} value={rsiMax} onChange={e => setRsiMax(e.target.value)} style={numInp} placeholder="e.g. 35" />
            </div>

            <div>
              <label style={{ fontSize: "12px", color: T.sub, display: "block", marginBottom: "5px" }}>Price vs 50-MA</label>
              <select value={aboveMa50} onChange={e => setAboveMa50(e.target.value as any)} style={{ ...selStyle, minWidth: "140px" }}>
                <option value="any">Any</option>
                <option value="yes">Above MA50 ↑</option>
                <option value="no">Below MA50 ↓</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: "16px" }}>
            <label style={{ fontSize: "12px", color: T.sub, display: "block", marginBottom: "5px" }}>Override: scan specific symbols (comma-separated)</label>
            <input
              type="text"
              value={manualSymbols}
              onChange={e => setManualSymbols(e.target.value)}
              placeholder="AAPL,MSFT,NVDA,GOOGL — leave blank to use screener + watchlist"
              style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "13px", padding: "8px 10px", outline: "none", boxSizing: "border-box" }}
            />
          </div>

          {selectedStrategy && strategies.find(s => s.id === selectedStrategy) && (
            <div style={{ background: `${T.accent}10`, border: `1px solid ${T.accent}30`, borderRadius: "8px", padding: "10px 14px", marginBottom: "14px", fontSize: "12px", color: T.sub }}>
              <span style={{ color: T.accent, fontWeight: 600 }}>{strategies.find(s => s.id === selectedStrategy)?.name}</span> — fundamental + technical filters pre-loaded from strategy definition. Custom fields above override strategy conditions.
            </div>
          )}

          <button
            onClick={runScan}
            disabled={scanning}
            style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "11px 28px", fontSize: "14px", fontWeight: 700, cursor: scanning ? "not-allowed" : "pointer", opacity: scanning ? 0.7 : 1 }}
          >
            {scanning ? "⏳ Scanning… (may take 30–60s)" : "⟐ Run Scanner"}
          </button>
          {scanning && <div style={{ fontSize: "11px", color: T.muted, marginTop: "8px" }}>Fetching RSI + EMA + fundamentals per symbol. AV free tier = ~5 calls/min. Please wait.</div>}
        </div>

        {error && (
          <div style={{ background: T.redBg, border: `1px solid ${T.red}44`, borderRadius: "10px", padding: "14px 18px", marginBottom: "20px", color: T.red, fontSize: "13px" }}>
            ⚠️ {error}
          </div>
        )}

        {result && (
          <>
            {/* Summary */}
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
              {[
                { label: "Scanned", value: result.total_scanned },
                { label: "Passing", value: result.passing, color: result.passing > 0 ? T.green : T.muted },
                { label: "Fundamentals", value: result.data_sources.fundamentals.includes("unavailable") ? "No FD key" : "FinancialDatasets", color: result.data_sources.fundamentals.includes("unavailable") ? T.red : T.green },
                { label: "Technicals", value: result.data_sources.technicals.includes("unavailable") ? "No AV key" : "Alpha Vantage", color: result.data_sources.technicals.includes("unavailable") ? T.red : T.green },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "12px 16px", minWidth: "120px" }}>
                  <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>{label}</div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: color ?? T.text }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Results table */}
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.surface }}>
                      {["Symbol", "Status", "Combined", "Fundamental", "Technical", "RSI", "Price", "vs MA50", "Notes"].map(h => (
                        <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, color: T.muted, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((r, i) => {
                      const bg = i % 2 === 0 ? "transparent" : `${T.surface}44`;
                      const combColor = r.combined_score >= 65 ? T.green : r.combined_score >= 50 ? T.amber : T.red;
                      return (
                        <tr key={r.symbol} style={{ borderBottom: `1px solid ${T.border}22`, background: bg }}>
                          <td style={{ padding: "9px 12px", fontWeight: 700 }}>
                            <button
                              onClick={() => router.push(`/dashboard/symbol/${r.symbol}`)}
                              style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: 0 }}
                            >
                              {r.symbol}
                            </button>
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{
                              fontSize: "10px", padding: "2px 8px", borderRadius: "20px", fontWeight: 600,
                              background: r.passes_filters ? T.greenBg : T.redBg,
                              color: r.passes_filters ? T.green : T.red,
                            }}>
                              {r.passes_filters ? "✓ PASS" : "✗ FAIL"}
                            </span>
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ fontWeight: 700, color: combColor }}>{r.combined_score}</span>
                            <ScoreBar value={r.combined_score} color={combColor} />
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ color: r.fundamental_score >= 65 ? T.green : r.fundamental_score >= 50 ? T.amber : T.red }}>{r.fundamental_score}</span>
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            <span style={{ color: r.technical_score >= 65 ? T.green : r.technical_score >= 50 ? T.amber : T.red }}>{r.technical_score}</span>
                          </td>
                          <td style={{ padding: "9px 12px", color: r.rsi != null ? (r.rsi > 60 ? T.green : r.rsi < 35 ? T.red : T.sub) : T.muted }}>
                            {r.rsi ?? "—"}
                          </td>
                          <td style={{ padding: "9px 12px", color: T.sub }}>
                            {r.price != null ? `${ccy}${r.price.toFixed(2)}` : "—"}
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            {r.price_above_ma50 == null ? <span style={{ color: T.muted }}>—</span>
                              : r.price_above_ma50 ? <span style={{ color: T.green }}>↑ above</span>
                              : <span style={{ color: T.red }}>↓ below</span>}
                          </td>
                          <td style={{ padding: "9px 12px", color: T.muted, fontSize: "11px", maxWidth: "200px" }}>
                            {r.filter_notes.join(", ")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {result.results.length > 10 && (
                <div style={{ padding: "12px 16px", borderTop: `1px solid ${T.border}` }}>
                  <button
                    onClick={() => setShowAll(!showAll)}
                    style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.sub, padding: "6px 16px", fontSize: "12px", cursor: "pointer" }}
                  >
                    {showAll ? "Show less" : `Show all ${result.results.length} results`}
                  </button>
                </div>
              )}
            </div>

            {result.passing === 0 && (
              <div style={{ marginTop: "12px", background: T.amberBg, border: `1px solid ${T.amber}30`, borderRadius: "10px", padding: "14px 18px", fontSize: "13px", color: T.amber }}>
                No symbols passed all filters. Try widening RSI range, removing MA50 filter, or selecting a different strategy. Scores still show which symbols are closest.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
