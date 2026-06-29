"use client";
import { useState, useEffect, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";

const SymbolChart = lazy(() => import("@/components/charts/SymbolChart"));

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

type Tab = "chart" | "signals" | "chat";

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

function LivePrice({ symbol }: { symbol: string }) {
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
      <span style={{ fontSize: "32px", fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>
        ${price.toFixed(2)}
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
    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "6px 0" }}>
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

function SignalsTab({ signals, trades }: { signals: any[]; trades: any[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
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
                  {t.qty}× @ ${Number(t.fill_price).toFixed(2)}
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
  symbol, signals, trades,
}: {
  symbol: string; signals: any[]; trades: any[];
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
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "24px 28px", display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "16px" }}>
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
          <LivePrice symbol={symbol} />
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

      {/* Tab bar */}
      <div style={{ display: "flex", gap: "4px", borderBottom: `1px solid ${T.border}`, paddingBottom: "4px" }}>
        <button style={tabStyle(tab === "chart")} onClick={() => setTab("chart")}>Chart</button>
        <button style={tabStyle(tab === "signals")} onClick={() => setTab("signals")}>
          Signals {signals.length > 0 ? `(${signals.length})` : ""}
        </button>
        <button style={tabStyle(tab === "chat")} onClick={() => setTab("chat")}>AI Chat</button>
      </div>

      {/* Tab content */}
      {tab === "chart" && (
        <Suspense fallback={<div style={{ height: "480px", background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted }}>Loading chart…</div>}>
          <SymbolChart symbol={symbol} />
        </Suspense>
      )}

      {tab === "signals" && (
        <div style={{ background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, padding: "20px 24px" }}>
          <SignalsTab signals={signals} trades={trades} />
        </div>
      )}

      {tab === "chat" && (
        <div style={{ background: T.card, borderRadius: "14px", border: `1px solid ${T.border}`, padding: "20px 24px" }}>
          <ChatTab symbol={symbol} />
        </div>
      )}
    </div>
  );
}
