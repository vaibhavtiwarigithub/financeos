"use client";
import { useState, useEffect, useRef } from "react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", dim: "#1C1F26",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16",
  red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2D1B00",
  blue: "#60A5FA",
};

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  const color = value >= 70 ? T.green : value >= 55 ? T.amber : T.red;
  return (
    <div style={{ marginBottom: "6px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px", fontSize: "11px" }}>
        <span style={{ color: T.muted }}>{label}</span>
        <span style={{ color, fontWeight: 600 }}>{value}</span>
      </div>
      <div style={{ height: "4px", background: T.border, borderRadius: "2px" }}>
        <div style={{ height: "100%", width: `${value}%`, background: color, borderRadius: "2px" }} />
      </div>
    </div>
  );
}

function DecisionCard({ packet, signal, trade }: { packet: any; signal?: any; trade?: any }) {
  const [open, setOpen] = useState(false);
  const outcome = trade?.outcome;
  const outcomeColor = outcome === "win" ? T.green : outcome === "loss" ? T.red : outcome === "breakeven" ? T.amber : T.muted;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", marginBottom: "12px", overflow: "hidden" }}>
      {/* Header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ padding: "16px 20px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ fontWeight: 800, fontSize: "15px", color: T.accent }}>{packet.symbol}</div>
          {packet.is_held_position && (
            <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: T.accentBg, color: T.accent }}>HELD</span>
          )}
          {signal && (
            <span style={{ fontSize: "11px", fontWeight: 600, color: signal.direction === "long" ? T.green : T.amber }}>
              {signal.direction?.toUpperCase()} · score {signal.analyst_score}
            </span>
          )}
          {trade && outcome && (
            <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px",
              background: outcome === "win" ? T.greenBg : outcome === "loss" ? T.redBg : T.amberBg,
              color: outcomeColor }}>
              {outcome.toUpperCase()} {trade.pnl_pct != null ? (trade.pnl_pct >= 0 ? "+" : "") + trade.pnl_pct.toFixed(1) + "%" : ""}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "11px", color: T.muted }}>{new Date(packet.created_at).toLocaleDateString()}</span>
          <span style={{ color: T.muted, fontSize: "14px" }}>{open ? "▾" : "▸"}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 20px 20px", borderTop: `1px solid ${T.border}` }}>
          {/* What the agent thought */}
          {packet.summary && (
            <div style={{ marginTop: "16px" }}>
              <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>What the agent saw</div>
              <p style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.6", margin: 0 }}>{packet.summary}</p>
            </div>
          )}

          {/* Score breakdown */}
          <div style={{ marginTop: "16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <div>
              <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>Score breakdown</div>
              <ScoreBar label="Fundamental" value={packet.fundamental_score} />
              <ScoreBar label="Technical" value={packet.technical_score} />
              <ScoreBar label="Sentiment" value={packet.sentiment_score} />
              <ScoreBar label="Macro" value={packet.macro_score} />
              <ScoreBar label="Insider" value={packet.insider_score} />
            </div>
            <div>
              {packet.catalysts && (
                <>
                  <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>Catalysts</div>
                  <p style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.5", margin: "0 0 12px" }}>{packet.catalysts}</p>
                </>
              )}
              {packet.key_risks && (
                <>
                  <div style={{ fontSize: "11px", color: T.red, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>Key risks</div>
                  <p style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.5", margin: 0 }}>{packet.key_risks}</p>
                </>
              )}
            </div>
          </div>

          {/* Trade result */}
          {trade && (
            <div style={{ marginTop: "16px", padding: "12px 14px", background: outcome === "win" ? T.greenBg : outcome === "loss" ? T.redBg : T.dim, borderRadius: "8px", borderLeft: `3px solid ${outcomeColor}` }}>
              <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Trade outcome</div>
              <div style={{ fontSize: "13px", color: T.text }}>
                Bought {trade.qty}sh @ ${trade.fill_price?.toFixed(2)}
                {trade.exit_price ? ` → sold @ $${trade.exit_price?.toFixed(2)}` : " (open)"}
                {trade.realized_pnl != null ? ` · ${trade.realized_pnl >= 0 ? "+" : ""}$${trade.realized_pnl.toFixed(2)}` : ""}
              </div>
              {trade.rationale && (
                <div style={{ fontSize: "12px", color: T.muted, marginTop: "6px", fontStyle: "italic" }}>
                  {trade.rationale.slice(0, 200)}{trade.rationale.length > 200 ? "…" : ""}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const STARTER_QUESTIONS = [
  "What is your current market thesis and what assumptions are you making?",
  "Walk me through why you picked your top-scored symbol this week.",
  "What mistakes have you made and what did you learn from them?",
  "What would change your mind on a position you're currently bullish on?",
  "How should I think about the difference between a score of 62 vs 78?",
];

export default function MentorPage({ packets, trades, log, signals }: {
  packets: any[]; trades: any[]; log: any[]; signals: any[];
}) {
  const [tab, setTab] = useState<"decisions" | "ask">("ask");
  const [thesis, setThesis] = useState<string | null>(null);
  const [thesisLoading, setThesisLoading] = useState(true);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const answerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/mentor/thesis")
      .then(r => r.json())
      .then(d => { setThesis(d.thesis ?? null); setThesisLoading(false); })
      .catch(() => setThesisLoading(false));
  }, []);

  async function ask(q?: string) {
    const text = (q ?? question).trim();
    if (!text || asking) return;
    setQuestion("");
    setAnswer("");
    setAsking(true);
    setTab("ask");

    try {
      const res = await fetch("/api/mentor/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6);
            if (payload === "[DONE]") break;
            try {
              const { text: chunk, error } = JSON.parse(payload);
              if (error) { setAnswer(prev => prev + `\n\n[Error: ${error}]`); break; }
              if (chunk) {
                setAnswer(prev => prev + chunk);
                answerRef.current?.scrollIntoView({ behavior: "smooth" });
              }
            } catch { /* skip malformed */ }
          }
        }
      }
    } finally {
      setAsking(false);
    }
  }

  // Build decision cards: match packets → signals → trades by symbol
  const signalMap = new Map(signals.map(s => [s.symbol, s]));
  const tradeMap = new Map(trades.map(t => [t.symbol, t]));
  const seenSymbols = new Set<string>();
  const decisionCards = packets.filter(p => {
    if (seenSymbols.has(p.symbol)) return false;
    seenSymbols.add(p.symbol);
    return true;
  });

  const TABS = [
    { key: "ask", label: "Ask the Agent" },
    { key: "decisions", label: "Decision Log" },
  ] as const;

  return (
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>

      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>Agent Mentor</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>Why the Agent Does What It Does</h1>
        <p style={{ fontSize: "13px", color: T.muted, margin: "6px 0 0" }}>Understand the reasoning behind every signal, trade, and outcome. Ask questions. Challenge the thesis.</p>
      </div>

      {/* Current market thesis */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.10em", textTransform: "uppercase" }}>Current Market Thesis</div>
          <button onClick={() => { setThesisLoading(true); fetch("/api/mentor/thesis?bust=1").then(r => r.json()).then(d => { setThesis(d.thesis ?? null); setThesisLoading(false); }).catch(() => setThesisLoading(false)); }}
            style={{ fontSize: "11px", color: T.muted, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            ↻ refresh
          </button>
        </div>
        {thesisLoading ? (
          <div style={{ color: T.muted, fontSize: "13px" }}>Generating thesis from latest research… (may take ~90s)</div>
        ) : thesis ? (
          <p style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", margin: 0, whiteSpace: "pre-wrap" }}>{thesis}</p>
        ) : (
          <div style={{ color: T.muted, fontSize: "13px" }}>
            No research data yet. Run ResearchAgent first — go to <a href="/dashboard/agents" style={{ color: T.accent }}>Agents →</a>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "20px" }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none",
              background: tab === t.key ? T.accent : T.card, color: tab === t.key ? "#fff" : T.muted }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Ask the Agent tab */}
      {tab === "ask" && (
        <div>
          {/* Starter questions */}
          {!answer && !asking && (
            <div style={{ marginBottom: "20px" }}>
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "10px" }}>Start with one of these:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {STARTER_QUESTIONS.map(q => (
                  <button key={q} onClick={() => ask(q)}
                    style={{ fontSize: "12px", padding: "8px 14px", borderRadius: "20px", border: `1px solid ${T.border}`, background: T.card, color: T.textSub, cursor: "pointer", textAlign: "left", maxWidth: "340px" }}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Answer display */}
          {(answer || asking) && (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "20px" }}>
              <div style={{ fontSize: "11px", color: T.accent, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "12px" }}>
                ◐ Agent Response {asking && <span style={{ color: T.muted }}>(thinking…)</span>}
              </div>
              <div style={{ fontSize: "14px", color: T.text, lineHeight: "1.7", whiteSpace: "pre-wrap" }}>
                {answer}
                {asking && <span style={{ color: T.muted }}>▌</span>}
              </div>
              <div ref={answerRef} />
            </div>
          )}

          {/* Input */}
          <div style={{ display: "flex", gap: "10px" }}>
            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
              placeholder="Ask anything — why it bought X, what assumptions it's making, why a trade lost, what you should watch for…"
              disabled={asking}
              rows={3}
              style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "12px 14px", color: T.text, fontSize: "13px", resize: "none", outline: "none", fontFamily: "'Inter', sans-serif", lineHeight: "1.5" }}
            />
            <button
              onClick={() => ask()}
              disabled={asking || !question.trim()}
              style={{ padding: "0 22px", borderRadius: "10px", background: asking ? T.dim : T.accent, color: "#fff", border: "none", cursor: asking ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "13px", whiteSpace: "nowrap" }}>
              {asking ? "Thinking…" : "Ask →"}
            </button>
          </div>
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px" }}>Enter to send · Shift+Enter for new line · Response streams in ~30-90s</div>
        </div>
      )}

      {/* Decision Log tab */}
      {tab === "decisions" && (
        <div>
          {decisionCards.length === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No research yet</div>
              <div style={{ fontSize: "13px", color: T.muted }}>
                Run ResearchAgent to start building the decision log. <a href="/dashboard/agents" style={{ color: T.accent }}>Go to Agents →</a>
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "14px" }}>
                {decisionCards.length} symbols researched · Click any card to see full reasoning, score breakdown, and trade outcome
              </div>
              {decisionCards.map(p => (
                <DecisionCard
                  key={p.id}
                  packet={p}
                  signal={signalMap.get(p.symbol)}
                  trade={tradeMap.get(p.symbol)}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
