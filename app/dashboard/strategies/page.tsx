"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import PageHeader from "@/components/dashboard/PageHeader";
import { useMarket } from "@/lib/market-context";

interface TopSymbol {
  symbol: string;
  fit_score: number;
}

interface Strategy {
  id: string;
  name: string;
  description: string;
  rules: Record<string, unknown>;
  top_symbols: TopSymbol[];
  us_only?: boolean;
}

function FitScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? "#34D399" : score >= 45 ? "#FBBF24" : "#F87171";
  return (
    <div style={{ marginTop: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "10px", color: "#9B9EA8", textTransform: "uppercase", letterSpacing: "0.08em" }}>Fit Score</span>
        <span style={{ fontSize: "12px", fontWeight: 700, color }}>{score}%</span>
      </div>
      <div style={{ height: "4px", borderRadius: "2px", background: "#252836", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${score}%`, background: color, borderRadius: "2px", transition: "width 0.5s ease" }} />
      </div>
    </div>
  );
}

function StrategyCard({ strategy }: { strategy: Strategy }) {
  const avgScore = strategy.top_symbols.length > 0
    ? Math.round(strategy.top_symbols.reduce((sum, s) => sum + s.fit_score, 0) / strategy.top_symbols.length)
    : 0;

  return (
    <div style={{
      background: "#1A1D27",
      border: "1px solid #252836",
      borderRadius: "12px",
      padding: "20px",
      display: "flex",
      flexDirection: "column",
      gap: "14px",
      transition: "border-color 0.15s",
    }}
    onMouseEnter={e => (e.currentTarget.style.borderColor = "#6366F1")}
    onMouseLeave={e => (e.currentTarget.style.borderColor = "#252836")}
    >
      <div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px" }}>
          <h3 style={{ fontSize: "15px", fontWeight: 600, color: "#ECEDEF", margin: 0 }}>{strategy.name}</h3>
          <span style={{
            fontSize: "10px",
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: "20px",
            background: strategy.us_only ? "rgba(155,158,168,0.15)" : "rgba(99,102,241,0.15)",
            color: strategy.us_only ? "#9B9EA8" : "#6366F1",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}>
            {strategy.us_only ? "US only" : "Strategy"}
          </span>
        </div>
        <p style={{ fontSize: "12px", color: "#9B9EA8", margin: "6px 0 0", lineHeight: 1.5 }}>
          {strategy.description}
        </p>
      </div>

      {strategy.top_symbols.length > 0 ? (
        <div>
          <div style={{ fontSize: "10px", color: "#9B9EA8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>
            Top Matches
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {strategy.top_symbols.map(s => {
              const chipColor = s.fit_score >= 70 ? "#34D399" : s.fit_score >= 45 ? "#FBBF24" : "#F87171";
              return (
                <Link
                  key={s.symbol}
                  href={`/dashboard/symbol/${s.symbol}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "4px 10px",
                    borderRadius: "20px",
                    background: "rgba(255,255,255,0.04)",
                    border: `1px solid ${chipColor}40`,
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "#ECEDEF",
                    textDecoration: "none",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                >
                  {s.symbol}
                  <span style={{ fontSize: "11px", color: chipColor }}>{s.fit_score}%</span>
                </Link>
              );
            })}
          </div>
          <FitScoreBar score={avgScore} />
        </div>
      ) : (
        <div style={{ fontSize: "12px", color: "#9B9EA8", fontStyle: "italic", padding: "8px 0" }}>
          {strategy.us_only ? "US market only — no India fit scores" : "No classifications yet"}
        </div>
      )}
    </div>
  );
}

export default function StrategiesPage() {
  const { market } = useMarket();
  const isIndia = market === "india";
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [symbolsInput, setSymbolsInput] = useState("AAPL,MSFT,NVDA,GOOGL,META,AMZN,TSLA,JPM,V,UNH");
  const [classifying, setClassifying] = useState(false);
  const [classifyStatus, setClassifyStatus] = useState<string | null>(null);

  const loadStrategies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/strategies?market=${market}`);
      if (res.ok) {
        const data = await res.json() as { strategies: Strategy[] };
        setStrategies(data.strategies ?? []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [market]);

  useEffect(() => { loadStrategies(); }, [loadStrategies]);

  async function runClassifier() {
    const symbols = symbolsInput.split(",").map(s => s.trim()).filter(Boolean);
    if (!symbols.length) return;
    setClassifying(true);
    setClassifyStatus(null);
    try {
      const res = await fetch("/api/strategies/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
      });
      if (res.ok) {
        const data = await res.json() as { results: Array<{ symbol: string }> };
        setClassifyStatus(`Classified ${data.results?.length ?? symbols.length} symbols successfully.`);
        await loadStrategies();
        setTimeout(() => setShowModal(false), 1500);
      } else {
        setClassifyStatus("Classification failed. Check API key.");
      }
    } catch {
      setClassifyStatus("Network error during classification.");
    } finally {
      setClassifying(false);
    }
  }

  const hasClassifications = strategies.some(s => s.top_symbols.length > 0);

  return (
    <div style={{ maxWidth: "1400px" }}>
      <PageHeader
        title="Strategy Intelligence"
        subtitle="7 strategies · classify symbols to see fit scores"
        cadence="as-needed"
        whatItDoes="Classifies any symbol against 7 investment strategies (Momentum, GARP, Value, Dividend, Growth, Macro, Contrarian) and shows fit scores so you know which stocks match your thesis."
        whatToLookFor={[
          "Green fit score (≥70%) = strong match for that strategy.",
          "Run Classifier with your watchlist symbols to see which strategies they belong to.",
          "Click any ticker chip to open full symbol analysis.",
          "Use this before adding new positions — confirms the strategy rationale.",
        ]}
        actions={[{ label: "Run Classifier", onClick: () => setShowModal(true), primary: true }]}
      />
      <div style={{ padding: "0 28px 32px" }}>

      {/* Sub-nav: Fit Scores (this page) ↔ Algo Library */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px", borderBottom: "1px solid #252836", paddingBottom: "0" }}>
        <div style={{ padding: "8px 14px", fontSize: "13px", fontWeight: 600, color: "#6366F1", borderBottom: "2px solid #6366F1", marginBottom: "-1px" }}>Fit Scores</div>
        <Link href="/dashboard/strategies/library" style={{ padding: "8px 14px", fontSize: "13px", fontWeight: 600, color: "#9B9EA8", textDecoration: "none", borderBottom: "2px solid transparent" }}>Algo Library →</Link>
      </div>

      {isIndia && (
        <div style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.25)", borderRadius: "10px", padding: "12px 16px", marginBottom: "20px", fontSize: "13px", color: "#9B9EA8", lineHeight: 1.5 }}>
          <strong style={{ color: "#ECEDEF" }}>🇮🇳 India selected.</strong> Fit-score classification runs on US market data only — these 7 templates are marked <strong style={{ color: "#ECEDEF" }}>US only</strong> and show no India scores rather than fabricated ones. The strategy <em>definitions</em> still apply to India; use the <Link href="/dashboard/scanner" style={{ color: "#6366F1" }}>Scanner</Link> to screen NIFTY-100 names against them in ₹.
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "16px" }}>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} style={{ height: "180px", background: "#1A1D27", border: "1px solid #252836", borderRadius: "12px", animation: "pulse 1.5s ease-in-out infinite" }} />
          ))}
        </div>
      ) : isIndia ? (
        // India: no classifier CTA (US-data classifier). Just show the templates,
        // each marked "US only" by the card. Note banner above explains why.
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "16px" }}>
          {strategies.map(s => <StrategyCard key={s.id} strategy={s} />)}
        </div>
      ) : !hasClassifications ? (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "16px",
          padding: "80px 0",
          color: "#9B9EA8",
        }}>
          <span style={{ fontSize: "40px" }}>◈</span>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "#ECEDEF" }}>No classifications yet</div>
          <div style={{ fontSize: "13px" }}>Enter symbols and click Run Classifier.</div>
          <button
            onClick={() => setShowModal(true)}
            style={{
              marginTop: "8px",
              padding: "10px 24px",
              borderRadius: "10px",
              background: "#6366F1",
              border: "none",
              color: "#fff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Run Classifier
          </button>
          {/* Still show the strategy cards without scores */}
          <div style={{ width: "100%", marginTop: "32px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "16px" }}>
            {strategies.map(s => <StrategyCard key={s.id} strategy={s} />)}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "16px" }}>
          {strategies.map(s => <StrategyCard key={s.id} strategy={s} />)}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <div style={{
            background: "#1A1D27",
            border: "1px solid #252836",
            borderRadius: "16px",
            padding: "28px",
            width: "100%",
            maxWidth: "480px",
            boxShadow: "0 24px 48px rgba(0,0,0,0.5)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <h2 style={{ fontSize: "17px", fontWeight: 700, color: "#ECEDEF", margin: 0 }}>
                Run Strategy Classifier
              </h2>
              <button
                onClick={() => setShowModal(false)}
                style={{ background: "none", border: "none", color: "#9B9EA8", fontSize: "18px", cursor: "pointer", lineHeight: 1 }}
              >
                ✕
              </button>
            </div>

            <label style={{ fontSize: "12px", color: "#9B9EA8", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Symbols (comma-separated)
            </label>
            <textarea
              value={symbolsInput}
              onChange={e => setSymbolsInput(e.target.value)}
              rows={3}
              style={{
                display: "block",
                width: "100%",
                marginTop: "8px",
                marginBottom: "16px",
                padding: "10px 12px",
                background: "#0D0F14",
                border: "1px solid #252836",
                borderRadius: "8px",
                color: "#ECEDEF",
                fontSize: "13px",
                resize: "vertical",
                outline: "none",
                fontFamily: "monospace",
                boxSizing: "border-box",
              }}
              placeholder="AAPL,MSFT,NVDA,GOOGL..."
            />

            {classifyStatus && (
              <div style={{
                marginBottom: "14px",
                padding: "10px 14px",
                borderRadius: "8px",
                background: classifyStatus.includes("success") ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)",
                border: `1px solid ${classifyStatus.includes("success") ? "#34D39940" : "#F8717140"}`,
                fontSize: "12px",
                color: classifyStatus.includes("success") ? "#34D399" : "#F87171",
              }}>
                {classifyStatus}
              </div>
            )}

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "8px",
                  background: "transparent",
                  border: "1px solid #252836",
                  color: "#9B9EA8",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={runClassifier}
                disabled={classifying}
                style={{
                  flex: 2,
                  padding: "10px",
                  borderRadius: "8px",
                  background: classifying ? "#4B4DCC" : "#6366F1",
                  border: "none",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: classifying ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                }}
              >
                {classifying ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 0.8s linear infinite" }}>
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                    </svg>
                    Classifying…
                  </>
                ) : "Run Classification"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.7; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      </div>
    </div>
  );
}
