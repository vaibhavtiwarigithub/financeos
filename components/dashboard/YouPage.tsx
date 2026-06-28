"use client";
import { useState } from "react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
  greenBg: "#052E16", redBg: "#3B0000",
};

const DNA_LABELS: Record<string, string> = {
  dna_macro: "Macro",
  dna_equities: "Equities",
  dna_fixed_income: "Fixed Income",
  dna_derivatives: "Derivatives",
  dna_risk_mgmt: "Risk Mgmt",
  dna_behavioral: "Behavioral",
  dna_technical: "Technical",
  dna_crypto: "Crypto",
};

function DnaBar({ label, value }: { label: string; value: number }) {
  const color = value >= 70 ? T.green : value >= 50 ? T.accent : T.amber;
  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "12px", color: T.textSub }}>{label}</span>
        <span style={{ fontSize: "12px", fontWeight: 700, color }}>{value}</span>
      </div>
      <div style={{ height: "5px", background: T.border, borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ width: value + "%", height: "100%", background: color, borderRadius: "3px" }} />
      </div>
    </div>
  );
}

export default function YouPage({ profile, predictions, journal, quizHistory }: {
  profile: any; predictions: any[]; journal: any[]; quizHistory: any[];
}) {
  const [tab, setTab] = useState<"dna" | "predictions" | "journal" | "quiz">("dna");

  const dnaKeys = Object.keys(DNA_LABELS);
  const dnaVals = dnaKeys.map(k => profile?.[k] ?? 50);
  const dnaAvg = Math.round(dnaVals.reduce((a, b) => a + b, 0) / dnaVals.length);

  const openPredictions = predictions.filter(p => p.status === "open");
  const closedPredictions = predictions.filter(p => p.status !== "open");
  const correctPredictions = closedPredictions.filter(p => p.outcome === "correct");
  const accuracy = closedPredictions.length ? Math.round((correctPredictions.length / closedPredictions.length) * 100) : null;

  return (
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>

      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>Your Profile</div>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div>
            <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em" }}>
              {profile?.full_name || "Investor"}
            </h1>
            <div style={{ fontSize: "13px", color: T.muted, marginTop: "2px" }}>
              {profile?.xp ?? 0} XP · {profile?.streak_days ?? 0} day streak · {profile?.analysis_count ?? 0} analyses
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px", marginBottom: "20px" }}>
        {[
          { label: "DNA Score", value: dnaAvg + "%", sub: "avg knowledge", color: T.accent },
          { label: "Open Predictions", value: String(openPredictions.length), sub: "pending outcome" },
          { label: "Prediction Accuracy", value: accuracy !== null ? accuracy + "%" : "—", sub: `${correctPredictions.length}/${closedPredictions.length} correct`, color: accuracy !== null ? (accuracy >= 60 ? T.green : T.red) : T.muted },
          { label: "Journal Entries", value: String(journal.length), sub: "total logged" },
        ].map(s => (
          <div key={s.label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px" }}>
            <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{s.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: s.color ?? T.text }}>{s.value}</div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px" }}>
        {(["dna", "predictions", "journal", "quiz"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === t ? T.accent : T.card, color: tab === t ? "#fff" : T.muted, textTransform: "capitalize" }}>
            {t === "dna" ? "DNA Profile" : t === "predictions" ? `Predictions (${predictions.length})` : t === "journal" ? `Journal (${journal.length})` : `Quiz (${quizHistory.length})`}
          </button>
        ))}
      </div>

      {/* DNA tab */}
      {tab === "dna" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "16px" }}>Knowledge DNA</div>
            {dnaKeys.map(k => (
              <DnaBar key={k} label={DNA_LABELS[k]} value={profile?.[k] ?? 50} />
            ))}
          </div>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "16px" }}>About</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                { label: "Full Name", value: profile?.full_name ?? "—" },
                { label: "Risk Tolerance", value: profile?.risk_tolerance ?? "—" },
                { label: "Investment Horizon", value: profile?.investment_horizon ?? "—" },
                { label: "Member Since", value: profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : "—" },
              ].map(f => (
                <div key={f.label}>
                  <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "2px" }}>{f.label}</div>
                  <div style={{ fontSize: "13px" }}>{f.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Predictions tab */}
      {tab === "predictions" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {predictions.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "24px 0" }}>No predictions yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Asset", "Direction", "Timeframe", "Confidence", "Status", "Outcome", "Created"].map(h => (
                    <th key={h} style={{ padding: "5px 12px 10px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {predictions.map((p: any) => (
                  <tr key={p.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>{p.asset}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: p.direction === "UP" ? T.greenBg : T.redBg, color: p.direction === "UP" ? T.green : T.red }}>
                        {p.direction}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{p.timeframe}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{p.confidence}%</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      <span style={{ fontSize: "11px", padding: "2px 7px", borderRadius: "4px", background: p.status === "open" ? "#2D1B00" : T.card, color: p.status === "open" ? T.amber : T.muted }}>
                        {p.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      {p.outcome ? (
                        <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 7px", borderRadius: "4px", background: p.outcome === "correct" ? T.greenBg : T.redBg, color: p.outcome === "correct" ? T.green : T.red }}>
                          {p.outcome}
                        </span>
                      ) : <span style={{ color: T.muted }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 0", color: T.muted, fontSize: "11px" }}>{new Date(p.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Journal tab */}
      {tab === "journal" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {journal.length === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", textAlign: "center", color: T.muted, fontSize: "13px" }}>
              No journal entries yet.
            </div>
          ) : journal.map((e: any) => (
            <div key={e.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", color: T.accent }}>{e.mood ?? "entry"}</span>
                <span style={{ fontSize: "11px", color: T.muted }}>{new Date(e.created_at).toLocaleString()}</span>
              </div>
              <div style={{ fontSize: "13px", lineHeight: 1.6, color: T.textSub }}>{e.content}</div>
              {e.tags && e.tags.length > 0 && (
                <div style={{ marginTop: "8px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {e.tags.map((tag: string) => (
                    <span key={tag} style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "4px", background: T.surface, color: T.muted }}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Quiz tab */}
      {tab === "quiz" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {quizHistory.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "24px 0" }}>No quiz history yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Topic", "Score", "Total", "Accuracy", "Date"].map(h => (
                    <th key={h} style={{ padding: "5px 12px 10px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quizHistory.map((q: any) => {
                  const acc = q.total_questions ? Math.round((q.correct_answers / q.total_questions) * 100) : 0;
                  return (
                    <tr key={q.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "10px 12px 10px 0", fontWeight: 600 }}>{q.topic ?? "General"}</td>
                      <td style={{ padding: "10px 12px 10px 0" }}>{q.correct_answers}</td>
                      <td style={{ padding: "10px 12px 10px 0" }}>{q.total_questions}</td>
                      <td style={{ padding: "10px 12px 10px 0", color: acc >= 70 ? T.green : acc >= 50 ? T.amber : T.red, fontWeight: 600 }}>{acc}%</td>
                      <td style={{ padding: "10px 0", color: T.muted, fontSize: "11px" }}>{new Date(q.completed_at).toLocaleDateString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
