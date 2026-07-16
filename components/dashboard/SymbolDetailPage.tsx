"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import TradingViewChart from "@/components/charts/TradingViewChart";
import SymbolFundamentals from "@/components/dashboard/SymbolFundamentals";
import SymbolPeers from "@/components/dashboard/SymbolPeers";
import DeepDivePanel from "@/components/dashboard/DeepDivePanel";
import StockContextStrip from "@/components/dashboard/StockContextStrip";
import { CURRENCY, type Market } from "@/lib/market-context";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

type Tab = "chart" | "deepdive" | "signals" | "options" | "chat" | "peers";

function dirColor(dir: string) {
  const d = (dir ?? "").toLowerCase();
  if (d === "long" || d === "buy") return T.green;
  if (d === "short" || d === "sell") return T.red;
  return T.amber;
}

function dirBg(dir: string) {
  const d = (dir ?? "").toLowerCase();
  if (d === "long" || d === "buy") return T.greenBg;
  if (d === "short" || d === "sell") return T.redBg;
  return T.amberBg;
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span style={{ color: T.muted }}>—</span>;
  const color = score >= 70 ? T.green : score >= 50 ? T.amber : T.red;
  return (
    <span style={{ fontWeight: 700, color, background: color + "18", padding: "2px 7px", borderRadius: "5px", fontSize: "12px" }}>
      {score}
    </span>
  );
}

// `market` is derived from the symbol's .NS/.BO suffix by the server page — NOT
// from the global switcher — because a symbol belongs to one market no matter
// what the switcher says. The quote it renders is in that market's currency.
function LivePrice({ symbol, market = "us" }: { symbol: string; market?: Market }) {
  const cur = CURRENCY[market] ?? "$";
  const [price, setPrice] = useState<number | null>(null);
  const [change, setChange] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/markets/quote?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => {
        if (d.price) setPrice(d.price);
        if (d.change !== undefined) setChange(d.change);
      })
      .catch(() => {});
  }, [symbol]);

  if (!price) return <span style={{ color: T.muted, fontSize: "13px" }}>Loading price…</span>;

  const pColor = change === null ? T.text : change >= 0 ? T.green : T.red;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
      <span style={{ fontSize: "clamp(24px,7vw,32px)", fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>
        {cur}{price.toFixed(2)}
      </span>
      {change !== null && (
        <span style={{ fontSize: "14px", fontWeight: 600, color: pColor, background: pColor + "18", padding: "3px 8px", borderRadius: "6px" }}>
          {change >= 0 ? "+" : ""}{change.toFixed(2)}%
        </span>
      )}
    </div>
  );
}

interface SocialSentimentData {
  symbol: string;
  stocktwits_bullish_pct: number | null;
  stocktwits_bearish_pct: number | null;
  stocktwits_message_count: number | null;
  av_news_sentiment: number | null;
  av_news_articles: number | null;
  overall_sentiment: "Bullish" | "Bearish" | "Neutral";
  fetched_at: string;
}

function SentimentWidget({ symbol }: { symbol: string }) {
  const [data, setData] = useState<SocialSentimentData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/social/sentiment?symbol=${symbol}`)
      .then(r => r.json())
      .then((d: SocialSentimentData) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [symbol]);

  if (loading) {
    return (
      <div style={{ fontSize: "12px", color: T.muted, padding: "6px 0" }}>
        Loading sentiment…
      </div>
    );
  }
  if (!data) return null;

  const chipColor =
    data.overall_sentiment === "Bullish" ? T.green :
    data.overall_sentiment === "Bearish" ? T.red :
    T.muted;
  const chipBg =
    data.overall_sentiment === "Bullish" ? T.greenBg :
    data.overall_sentiment === "Bearish" ? T.redBg :
    "#1A1D27";

  const stPart = data.stocktwits_bullish_pct !== null
    ? `StockTwits: ${data.stocktwits_bullish_pct}% Bullish`
    : "StockTwits: n/a";

  const newsPart = data.av_news_sentiment !== null
    ? `News: ${data.av_news_sentiment.toFixed(2)}`
    : "News: n/a";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "6px 0", flexWrap: "wrap" }}>
      <span style={{
        fontSize: "11px", fontWeight: 700, padding: "3px 10px", borderRadius: "20px",
        color: chipColor, background: chipBg,
        border: `1px solid ${chipColor}30`,
        letterSpacing: "0.02em",
      }}>
        {data.overall_sentiment}
      </span>
      <span style={{ fontSize: "12px", color: T.textSub }}>
        {stPart}
      </span>
      <span style={{ fontSize: "12px", color: T.muted }}>·</span>
      <span style={{ fontSize: "12px", color: T.textSub }}>
        {newsPart}
      </span>
      {data.stocktwits_message_count !== null && (
        <>
          <span style={{ fontSize: "12px", color: T.muted }}>·</span>
          <span style={{ fontSize: "11px", color: T.muted }}>
            {data.stocktwits_message_count} msgs
          </span>
        </>
      )}
    </div>
  );
}

// Score trajectory: how the research agent's analyst_score for this symbol has
// moved over time. Reveals whether conviction is rising or falling. Data comes
// from signal_score_history (append-only), which accumulates on every re-score —
// far denser than agent_signals, so a real trend line actually shows up.
interface ScoreHistoryRow {
  symbol: string;
  analyst_score: number | null;
  fundamental_score: number | null;
  technical_score: number | null;
  sentiment_score: number | null;
  macro_score: number | null;
  insider_score: number | null;
  direction: string | null;
  source: string | null;
  created_at: string;
}

function ScoreTrajectory({ symbol }: { symbol: string }) {
  const [history, setHistory] = useState<ScoreHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/charts/score-history?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => setHistory(Array.isArray(d.history) ? d.history : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [symbol]);

  const scoreColor = (v: number) => v >= 70 ? T.green : v >= 50 ? T.amber : T.red;

  const pts = history
    .filter(s => s.analyst_score != null && s.created_at)
    .map(s => ({ score: Number(s.analyst_score), t: new Date(s.created_at).getTime() }))
    .sort((a, b) => a.t - b.t);

  // Latest dimension breakdown (last row that actually has values).
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const dims: { label: string; value: number | null }[] = latest
    ? [
        { label: "Fundamental", value: latest.fundamental_score },
        { label: "Technical", value: latest.technical_score },
        { label: "Sentiment", value: latest.sentiment_score },
        { label: "Macro", value: latest.macro_score },
        { label: "Insider", value: latest.insider_score },
      ]
    : [];

  const DimChips = () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: pts.length >= 2 ? "12px" : "0" }}>
      {dims.map(d => {
        const v = d.value == null ? null : Number(d.value);
        const c = v == null ? T.muted : scoreColor(v);
        return (
          <span key={d.label} style={{
            fontSize: "11px", fontWeight: 600, padding: "3px 9px", borderRadius: "6px",
            color: c, background: c + "18", border: `1px solid ${c}30`,
            display: "inline-flex", alignItems: "center", gap: "5px",
          }}>
            <span style={{ color: T.muted, fontWeight: 500 }}>{d.label}</span>
            {v == null ? "—" : Math.round(v)}
          </span>
        );
      })}
    </div>
  );

  if (loading) {
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px", fontSize: "12px", color: T.muted }}>
        Loading score history…
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px", fontSize: "12px", color: T.muted }}>
        No score history yet — accumulates as the research agent re-scores this symbol.
      </div>
    );
  }

  // Only 1 data point: show the dimension breakdown, skip the (impossible) line.
  if (pts.length < 2) {
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px" }}>
        <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>
          Score Breakdown · latest re-score
        </div>
        <div style={{ fontSize: "10px", color: T.muted, marginBottom: "6px" }}>
          One data point so far — trend line appears after the next re-score.
        </div>
        <DimChips />
      </div>
    );
  }

  const W = 100, H = 40, pad = 2;
  const xs = pts.map((_, i) => pad + (i / (pts.length - 1)) * (W - 2 * pad));
  const ys = pts.map(p => H - pad - (p.score / 100) * (H - 2 * pad));
  const path = pts.map((_, i) => `${i === 0 ? "M" : "L"} ${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`).join(" ");
  const first = pts[0].score, last = pts[pts.length - 1].score;
  const delta = last - first;

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <span style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Score Trajectory · {pts.length} re-scores
        </span>
        <span style={{ fontSize: "12px", fontWeight: 700, color: delta > 0 ? T.green : delta < 0 ? T.red : T.muted }}>
          {first} → {last} {delta !== 0 && `(${delta > 0 ? "+" : ""}${delta})`}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "56px", display: "block" }}>
        {/* 50 & 60 reference lines */}
        <line x1={0} x2={W} y1={H - pad - 0.5 * (H - 2 * pad)} y2={H - pad - 0.5 * (H - 2 * pad)} stroke={T.border} strokeWidth={0.4} strokeDasharray="2 2" />
        <line x1={0} x2={W} y1={H - pad - 0.6 * (H - 2 * pad)} y2={H - pad - 0.6 * (H - 2 * pad)} stroke={T.green} strokeWidth={0.4} strokeDasharray="2 2" opacity={0.5} />
        <path d={path} fill="none" stroke={T.accent} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <circle key={i} cx={xs[i]} cy={ys[i]} r={1.4} fill={scoreColor(p.score)} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div style={{ fontSize: "10px", color: T.muted, marginTop: "4px" }}>
        Green dashed = 60 (buy threshold) · grey dashed = 50. Points colored by score.
      </div>
      <DimChips />
    </div>
  );
}

function SignalsTab({ symbol, signals, trades, market = "us" }: { symbol: string; signals: any[]; trades: any[]; market?: Market }) {
  const cur = CURRENCY[market] ?? "$";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <ScoreTrajectory symbol={symbol} />
      {/* Agent signals */}
      <div>
        <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "12px" }}>
          Agent Signals ({signals.length})
        </div>
        {signals.length === 0 ? (
          <div style={{ color: T.muted, fontSize: "13px" }}>No signals yet for this symbol.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {signals.map(s => (
              <div key={s.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                  <span style={{
                    fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "5px",
                    color: dirColor(s.direction), background: dirBg(s.direction),
                  }}>
                    {(s.direction ?? "neutral").toUpperCase()}
                  </span>
                  <ScoreBadge score={s.analyst_score} />
                  {s.conviction && (
                    <span style={{ fontSize: "11px", color: T.muted }}>{s.conviction} conviction</span>
                  )}
                  <span style={{ fontSize: "11px", color: T.muted, marginLeft: "auto" }}>
                    {s.created_at ? new Date(s.created_at).toLocaleDateString() : ""}
                  </span>
                  <span style={{
                    fontSize: "10px", padding: "1px 6px", borderRadius: "4px",
                    background: T.border, color: T.textSub,
                  }}>
                    {s.status}
                  </span>
                </div>
                {s.rationale && (
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.55" }}>
                    {s.rationale}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Paper trades */}
      {trades.length > 0 && (
        <div>
          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "12px" }}>
            Paper Trades ({trades.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {trades.map(t => (
              <div key={t.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "5px", color: t.order_side === "buy" ? T.green : T.red, background: t.order_side === "buy" ? T.greenBg : T.redBg }}>
                  {(t.order_side ?? "").toUpperCase()}
                </span>
                <span style={{ fontSize: "13px", color: T.text, fontFamily: "monospace" }}>
                  {t.qty}× @ {cur}{Number(t.fill_price).toFixed(2)}
                </span>
                <span style={{ fontSize: "11px", color: T.muted, marginLeft: "auto" }}>
                  {t.executed_at ? new Date(t.executed_at).toLocaleDateString() : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionsTab({ symbol }: { symbol: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/options/chain?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch(() => setError("Failed to load options data"))
      .finally(() => setLoading(false));
  }, [symbol]);

  if (loading) return <div style={{ color: T.muted, fontSize: "13px", padding: "20px 0" }}>Loading options chain…</div>;
  if (error) return <div style={{ color: T.red, fontSize: "13px", padding: "20px 0" }}>{error}</div>;
  if (!data?.calls?.length && !data?.puts?.length) return <div style={{ color: T.muted, fontSize: "13px" }}>No options data available.</div>;

  const putCallRatio = data.put_call_ratio;
  const impliedVolatility = data.avg_iv;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Summary row */}
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
        {putCallRatio != null && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px" }}>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Put/Call Ratio</div>
            <div style={{ fontSize: "20px", fontWeight: 700, color: putCallRatio > 1 ? T.red : putCallRatio < 0.7 ? T.green : T.amber }}>
              {putCallRatio.toFixed(2)}
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
              {putCallRatio > 1 ? "Bearish lean" : putCallRatio < 0.7 ? "Bullish lean" : "Neutral"}
            </div>
          </div>
        )}
        {impliedVolatility != null && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px" }}>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Avg IV</div>
            <div style={{ fontSize: "20px", fontWeight: 700, color: impliedVolatility > 60 ? T.red : T.amber }}>
              {(impliedVolatility * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
              {impliedVolatility > 0.6 ? "High volatility" : "Normal range"}
            </div>
          </div>
        )}
        {data.expiry && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px" }}>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Nearest Expiry</div>
            <div style={{ fontSize: "16px", fontWeight: 700, color: T.text }}>{data.expiry}</div>
          </div>
        )}
      </div>

      {/* Calls + Puts tables */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "16px" }}>
        {[
          { label: "Calls", rows: data.calls ?? [], color: T.green },
          { label: "Puts", rows: data.puts ?? [], color: T.red },
        ].map(({ label, rows, color }) => (
          <div key={label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}`, fontSize: "11px", fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {label} ({rows.length})
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    {["Strike", "Bid", "Ask", "IV", "OI", "Vol"].map(h => (
                      <th key={h} style={{ padding: "6px 10px", textAlign: "right", color: T.muted, fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 10).map((r: any, i: number) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${T.border}22` }}>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: T.text }}>${r.strike}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: T.textSub }}>{r.bid ?? "—"}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: T.textSub }}>{r.ask ?? "—"}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: T.amber }}>{r.implied_volatility != null ? (r.implied_volatility * 100).toFixed(0) + "%" : "—"}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: T.muted }}>{r.open_interest?.toLocaleString() ?? "—"}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: T.muted }}>{r.volume?.toLocaleString() ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChatTab({ symbol }: { symbol: string }) {
  const [messages, setMessages] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send() {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", text: q }]);
    setLoading(true);
    try {
      const res = await fetch("/api/mentor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, context: `Symbol: ${symbol}` }),
      });
      const d = await res.json();
      setMessages(prev => [...prev, { role: "ai", text: d.response ?? d.error ?? "No response" }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "ai", text: "Error: " + String(e) }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", minHeight: "300px" }}>
      <div style={{ fontSize: "12px", color: T.muted }}>
        Ask the agent about {symbol} — price action, fundamentals, thesis, risks.
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "10px", maxHeight: "400px", overflowY: "auto" }}>
        {messages.map((m, i) => (
          <div key={i} style={{
            padding: "12px 14px", borderRadius: "10px",
            background: m.role === "user" ? T.accent + "18" : T.surface,
            border: `1px solid ${m.role === "user" ? T.accent + "30" : T.border}`,
            fontSize: "13px", lineHeight: "1.6", color: T.text,
            alignSelf: m.role === "user" ? "flex-end" : "flex-start",
            maxWidth: "90%",
          }}>
            <div style={{ fontSize: "10px", color: T.muted, marginBottom: "4px" }}>
              {m.role === "user" ? "You" : "Agent"}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
          </div>
        ))}
        {loading && (
          <div style={{ padding: "12px 14px", borderRadius: "10px", background: T.surface, border: `1px solid ${T.border}`, fontSize: "13px", color: T.muted }}>
            Thinking… (~30–90s)
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={`Ask about ${symbol}…`}
          rows={2}
          style={{
            flex: 1, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px",
            color: T.text, padding: "10px 12px", fontSize: "13px", resize: "none",
            outline: "none",
          }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          style={{
            padding: "10px 18px", borderRadius: "8px", fontWeight: 700, fontSize: "13px",
            background: loading ? T.border : T.accent, color: loading ? T.muted : "white",
            border: "none", cursor: loading ? "default" : "pointer",
          }}
        >
          Ask →
        </button>
      </div>
    </div>
  );
}

export default function SymbolDetailPage({
  symbol, market, signals, trades,
}: {
  symbol: string; market?: "us" | "india"; signals: any[]; trades: any[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("chart");

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: "8px 16px", borderRadius: "8px", fontSize: "12px", fontWeight: 600,
    cursor: "pointer", border: "none",
    background: active ? T.accent + "20" : "transparent",
    color: active ? T.accent : T.muted,
  });

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "clamp(12px, 4vw, 24px) clamp(12px, 4vw, 28px)", display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
        <button
          onClick={() => router.back()}
          style={{ background: T.card, border: `1px solid ${T.border}`, color: T.textSub, padding: "8px 14px", borderRadius: "8px", cursor: "pointer", fontSize: "12px", marginTop: "4px" }}
        >
          ← Back
        </button>
        <div>
          <div style={{ fontSize: "28px", fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginBottom: "4px" }}>
            {symbol}
          </div>
          <LivePrice symbol={symbol} market={market} />
          <SentimentWidget symbol={symbol} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
          {signals.length > 0 && (
            <span style={{
              fontSize: "12px", padding: "4px 10px", borderRadius: "6px",
              background: dirBg(signals[0].direction), color: dirColor(signals[0].direction),
              fontWeight: 700, border: `1px solid ${dirColor(signals[0].direction)}30`,
            }}>
              Latest: {(signals[0].direction ?? "").toUpperCase()} · Score {signals[0].analyst_score ?? "—"}
            </span>
          )}
        </div>
      </div>

      {/* Stock Context strip — display-only "what is this stock" (off money path) */}
      <StockContextStrip symbol={symbol} market={market} />

      {/* Tab bar */}
      <div style={{ display: "flex", gap: "4px", borderBottom: `1px solid ${T.border}`, paddingBottom: "4px", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        <button style={tabStyle(tab === "chart")} onClick={() => setTab("chart")}>Chart</button>
        <button style={tabStyle(tab === "deepdive")} onClick={() => setTab("deepdive")}>🔬 Deep Dive</button>
        <button style={tabStyle(tab === "signals")} onClick={() => setTab("signals")}>
          Signals {signals.length > 0 ? `(${signals.length})` : ""}
        </button>
        <button style={tabStyle(tab === "options")} onClick={() => setTab("options")}>Options</button>
        <button style={tabStyle(tab === "chat")} onClick={() => setTab("chat")}>AI Chat</button>
        <button style={tabStyle(tab === "peers")} onClick={() => setTab("peers")}>Peers</button>
      </div>

      {/* Tab content */}
      {tab === "chart" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <TradingViewChart symbol={symbol} height={520} />
          <SymbolFundamentals symbol={symbol} market={market} />
        </div>
      )}

      {tab === "deepdive" && (
        <div style={{ background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, padding: "20px clamp(14px,4vw,24px)" }}>
          <DeepDivePanel symbol={symbol} />
        </div>
      )}

      {tab === "signals" && (
        <div style={{ background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, padding: "20px clamp(14px,4vw,24px)" }}>
          <SignalsTab symbol={symbol} signals={signals} trades={trades} market={market} />
        </div>
      )}

      {tab === "options" && (
        <div style={{ background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, padding: "20px clamp(14px,4vw,24px)" }}>
          <OptionsTab symbol={symbol} />
        </div>
      )}

      {tab === "chat" && (
        <div style={{ background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, padding: "20px clamp(14px,4vw,24px)" }}>
          <ChatTab symbol={symbol} />
        </div>
      )}

      {tab === "peers" && (
        <div style={{ background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, padding: "20px clamp(14px,4vw,24px)" }}>
          <SymbolPeers symbol={symbol} />
        </div>
      )}
    </div>
  );
}
