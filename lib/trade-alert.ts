import { createServiceClient } from "@/lib/supabase/service";
import { getEmailProvider } from "@/lib/providers/email";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "vterminater@gmail.com";
const FROM = "Kairos <alerts@kairos.trade>";
const DASHBOARD = "http://localhost:3000/dashboard/smart-money";

const C = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", red: "#F87171",
  greenBg: "#052E16", amberBg: "#2D1B00", redBg: "#3B0000",
};

function scoreColor(s: number) { return s >= 70 ? C.green : s >= 50 ? C.amber : C.red; }
function scoreBg(s: number)    { return s >= 70 ? C.greenBg : s >= 50 ? C.amberBg : C.redBg; }
function pct(w: unknown)       { return `${(parseFloat(String(w)) * 100).toFixed(0)}%`; }
function regimeColor(r: string){ return ({ GREEN: C.green, YELLOW: C.amber, ORANGE: "#F97316", RED: C.red })[r] ?? C.muted; }
function scoreBar(s: number)   {
  const filled = Math.round(s / 10);
  return Array.from({ length: 10 }, (_, i) =>
    `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:2px;background:${i < filled ? scoreColor(s) : C.border}"></span>`
  ).join("");
}

function wrap(body: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${C.bg};font-family:'Courier New',monospace;color:${C.text}">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">${body}</div>
</body></html>`;
}

function header(emoji: string, title: string, subtitle: string): string {
  return `
<div style="border-bottom:1px solid ${C.border};padding-bottom:16px;margin-bottom:20px">
  <div style="font-size:11px;color:${C.accent};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px">Kairos — Agentic Trading System</div>
  <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em">${emoji} ${title}</div>
  <div style="font-size:13px;color:${C.sub};margin-top:4px">${subtitle}</div>
</div>`;
}

function scoreRow(label: string, score: number | null, weight: string, desc: string): string {
  const s = score ?? 0;
  return `
<tr>
  <td style="padding:10px 12px;border-bottom:1px solid ${C.border}">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;font-weight:700;color:${C.sub};width:96px;flex-shrink:0">${label}</span>
      <span style="font-size:16px;font-weight:700;color:${scoreColor(s)};width:30px">${score ?? "—"}</span>
      <span>${scoreBar(s)}</span>
      <span style="font-size:10px;padding:2px 7px;border-radius:4px;background:${scoreBg(s)};color:${scoreColor(s)};margin-left:4px">weight ${weight}</span>
    </div>
    <div style="font-size:11px;color:${C.muted};margin-top:4px;padding-left:104px">${desc}</div>
  </td>
</tr>`;
}

function btn(label: string, url: string, color: string, bg: string): string {
  return `<a href="${url}" style="display:inline-block;padding:10px 22px;background:${bg};border:1px solid ${color};border-radius:8px;color:${color};font-size:13px;font-weight:700;text-decoration:none;font-family:'Courier New',monospace">${label}</a>`;
}

// ── main export: proposal alert ───────────────────────────────────────────────

export interface TradeAlertOpts {
  proposalId: number;
  signalId?: number | null;
  symbol: string;
  side: string;
  qty: number;
  orderType: string;
  priceAtProposal: number;
  estimatedValue: number;
  pctOfNav: number;
  analystScore: number;
  thesis?: string | null;
  expiresAt: string;
  riskCheckPass?: boolean;
  priceDriftWarning?: string | null;
}

export async function sendTradeAlertEmail(opts: TradeAlertOpts): Promise<void> {

  const sb = createServiceClient();

  // Fetch enrichment data in parallel
  const [signalRes, weightsRes, learnerRes, regimeRes] = await Promise.all([
    opts.signalId
      ? sb.from("agent_signals").select("fundamental_score,technical_score,sentiment_score,macro_score,analyst_score,insider_score,rationale,risks,summary,is_holding,conviction").eq("id", opts.signalId).single()
      : Promise.resolve({ data: null }),
    sb.from("signal_weights").select("*").single(),
    sb.from("learner_runs").select("win_rate_snapshot,weight_mutations,mutations_paused,run_date").order("created_at", { ascending: false }).limit(1).single(),
    sb.from("macro_regime").select("regime,danger_score,computed_at").order("computed_at", { ascending: false }).limit(1).single(),
  ]);

  const sig     = (signalRes.data ?? {}) as any;
  const weights = (weightsRes.data ?? {}) as any;
  const learner = (learnerRes.data ?? {}) as any;
  const regime  = (regimeRes.data ?? {}) as any;

  const thesis = opts.thesis ?? sig.rationale ?? sig.summary ?? "No thesis available.";
  const risks  = Array.isArray(sig.risks) ? sig.risks : (sig.risks ? [sig.risks] : []);
  const expiresIn = Math.max(0, Math.round((new Date(opts.expiresAt).getTime() - Date.now()) / 60000));
  const winRate = learner.win_rate_snapshot != null ? `${(learner.win_rate_snapshot * 100).toFixed(0)}%` : "—";
  const regimeLabel = regime.regime ?? "UNKNOWN";
  const dangerScore = regime.danger_score ?? 0;

  // Weight mutation context from latest learner run
  let mutationNote = "";
  if (learner.weight_mutations && Array.isArray(learner.weight_mutations)) {
    const muts: string[] = (learner.weight_mutations as any[]).slice(0, 3).map((m: any) =>
      `${m.dimension ?? m.key}: ${m.old_value ?? m.from} → ${m.new_value ?? m.to}${m.direction ? ` (${m.direction})` : ""}`
    );
    if (muts.length) mutationNote = `Last weight changes (${learner.run_date ?? "recent"}): ${muts.join(" · ")}`;
  }
  if (learner.mutations_paused) mutationNote = "⚠️ Weight mutations paused — win rate too low for safe learning.";

  const sideLabel   = opts.side.toUpperCase();
  const sideEmoji   = opts.side === "buy" ? "🟢" : "🔴";
  const sideColor   = opts.side === "buy" ? C.green : C.red;
  const sideBg      = opts.side === "buy" ? C.greenBg : C.redBg;
  const scoreColor_ = scoreColor(opts.analystScore);

  const subject = `${sideEmoji} Kairos: ${sideLabel} ${opts.qty}× ${opts.symbol} — Score ${opts.analystScore} — expires in ${expiresIn}m`;

  const html = wrap(`
${header(sideEmoji, `${sideLabel} ${opts.symbol}`, `Research Agent trade proposal — ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`)}

<!-- Signal summary card -->
<div style="background:${C.card};border:1px solid ${opts.riskCheckPass ? C.accent + "44" : C.amber + "44"};border-radius:12px;padding:18px 20px;margin-bottom:20px">
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
    <div>
      <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px">Signal</div>
      <div style="font-size:18px;font-weight:700;color:${sideColor}">${sideLabel} ${opts.qty} shares</div>
      <div style="font-size:12px;color:${C.sub}">@ $${opts.priceAtProposal.toFixed(2)} · ${opts.orderType}</div>
    </div>
    <div>
      <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px">Portfolio Impact</div>
      <div style="font-size:18px;font-weight:700">$${opts.estimatedValue.toFixed(0)}</div>
      <div style="font-size:12px;color:${C.sub}">${(opts.pctOfNav * 100).toFixed(1)}% of NAV</div>
    </div>
    <div>
      <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px">Analyst Score</div>
      <div style="font-size:18px;font-weight:700;color:${scoreColor_}">${opts.analystScore}</div>
      <div style="font-size:12px;color:${C.sub}">threshold 70 · ${opts.riskCheckPass ? "✓ risk pass" : "⚠ risk flag"}</div>
    </div>
  </div>
  <div style="font-size:11px;color:${C.amber};background:${C.amberBg};border-radius:6px;padding:6px 10px;display:inline-block">
    ⏰ Expires in ${expiresIn} min — price re-checked at approval
  </div>
  ${opts.priceDriftWarning ? `<div style="font-size:11px;color:${C.red};margin-top:6px">⚠️ ${opts.priceDriftWarning}</div>` : ""}
</div>

<!-- Thesis -->
<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:18px 20px;margin-bottom:16px">
  <div style="font-size:9px;color:${C.accent};text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:10px">The Thesis</div>
  <div style="font-size:13px;color:${C.sub};line-height:1.8">${thesis.replace(/\n/g, "<br>")}</div>
</div>

<!-- Score breakdown -->
<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:18px 20px;margin-bottom:16px">
  <div style="font-size:9px;color:${C.accent};text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:12px">Evidence Breakdown</div>
  <table style="width:100%;border-collapse:collapse">
    ${scoreRow("Fundamental", sig.fundamental_score ?? null, pct(weights.fundamental_weight ?? 0.30), "P/E vs sector, FCF yield, revenue growth, earnings revisions")}
    ${scoreRow("Technical", sig.technical_score ?? null, pct(weights.technical_weight ?? 0.25), "RSI(14), EMA crossover, price vs 50-day MA, volume trend")}
    ${scoreRow("Sentiment", sig.sentiment_score ?? null, pct(weights.sentiment_weight ?? 0.20), "News tone, StockTwits bullish ratio, analyst upgrade/downgrade")}
    ${scoreRow("Macro", sig.macro_score ?? null, pct(weights.macro_weight ?? 0.15), "MacroSentinel regime overlay, sector exposure, yield curve")}
    ${scoreRow("Insider", sig.insider_score ?? null, pct(weights.insider_weight ?? 0.10), "Form 4 filings — executive buy clusters, AV insider transaction data")}
  </table>
</div>

<!-- LearnerAgent context -->
<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:14px 18px;margin-bottom:16px">
  <div style="font-size:9px;color:${C.accent};text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:8px">LearnerAgent Context</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:8px">
    <div><span style="font-size:11px;color:${C.muted}">Win rate </span><span style="font-size:14px;font-weight:700;color:${winRate !== "—" && parseFloat(winRate) >= 55 ? C.green : C.amber}">${winRate}</span></div>
    <div><span style="font-size:11px;color:${C.muted}">Weights updated </span><span style="font-size:13px;color:${C.sub}">${learner.run_date ?? "never"}</span></div>
    <div><span style="font-size:11px;color:${C.muted}">Current weights </span><span style="font-size:13px;color:${C.sub}">F${pct(weights.fundamental_weight ?? 0.30)} T${pct(weights.technical_weight ?? 0.25)} S${pct(weights.sentiment_weight ?? 0.20)} M${pct(weights.macro_weight ?? 0.15)} I${pct(weights.insider_weight ?? 0.10)}</span></div>
  </div>
  ${mutationNote ? `<div style="font-size:11px;color:${C.muted};border-top:1px solid ${C.border};padding-top:8px">${mutationNote}</div>` : ""}
</div>

<!-- Macro regime -->
<div style="background:${C.card};border:1px solid ${regimeColor(regimeLabel)}33;border-radius:12px;padding:14px 18px;margin-bottom:16px">
  <div style="font-size:9px;color:${C.accent};text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:8px">Macro Environment</div>
  <div style="display:flex;align-items:center;gap:12px">
    <span style="font-size:14px;font-weight:700;color:${regimeColor(regimeLabel)}">${regimeLabel}</span>
    <span style="font-size:12px;color:${C.sub}">Danger score: ${dangerScore}/100</span>
    ${dangerScore >= 60 ? `<span style="font-size:11px;color:${C.red};background:${C.redBg};padding:2px 8px;border-radius:4px">Elevated risk — size conservatively</span>` : ""}
  </div>
</div>

${risks.length > 0 ? `
<!-- Risks -->
<div style="background:${C.redBg};border:1px solid ${C.red}33;border-radius:12px;padding:14px 18px;margin-bottom:20px">
  <div style="font-size:9px;color:${C.red};text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:8px">Key Risks</div>
  <ul style="margin:0;padding:0 0 0 16px;display:flex;flex-direction:column;gap:4px">
    ${risks.map((r: string) => `<li style="font-size:12px;color:${C.sub};line-height:1.6">${r}</li>`).join("")}
  </ul>
</div>` : ""}

<!-- CTA -->
<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:18px 20px;margin-bottom:24px;text-align:center">
  <div style="font-size:12px;color:${C.sub};margin-bottom:14px">Proposal #${opts.proposalId} · Account ••••0660 · Review in dashboard before approving</div>
  <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
    ${btn("→ Review & Approve", DASHBOARD, C.green, C.greenBg)}
    ${btn("→ View Dashboard", DASHBOARD, C.accent, "#1E1F3A")}
  </div>
</div>

<!-- Footer -->
<div style="border-top:1px solid ${C.border};padding-top:14px;font-size:10px;color:${C.muted};line-height:1.8">
  <strong>Kairos Agentic Trading System</strong> · Proposal ID ${opts.proposalId}<br>
  All trades require explicit approval. Kairos does not provide investment advice.<br>
  If you did not request this — disable trading in Settings → Strategy immediately.
</div>
`);

  await getEmailProvider().send({ from: FROM, to: ADMIN_EMAIL, subject, html });
}

// ── reminder email (sent 25 min after proposal, if still pending) ─────────────

export async function sendProposalReminderEmail(proposal: {
  id: number;
  symbol: string;
  side: string;
  qty: number;
  analyst_score: number;
  price_at_proposal: number;
  approval_expires_at: string;
  thesis?: string;
}): Promise<void> {

  const minutesLeft = Math.max(0, Math.round((new Date(proposal.approval_expires_at).getTime() - Date.now()) / 60000));
  const sideEmoji   = proposal.side === "buy" ? "🟢" : "🔴";
  const subject     = `⏰ REMINDER: ${sideEmoji} ${proposal.side.toUpperCase()} ${proposal.qty}× ${proposal.symbol} — ${minutesLeft}m left`;

  const html = wrap(`
${header("⏰", `Pending Trade — ${minutesLeft} min to decide`, `${proposal.side.toUpperCase()} ${proposal.qty}× ${proposal.symbol} @ $${proposal.price_at_proposal.toFixed(2)}`)}

<div style="background:${C.amberBg};border:1px solid ${C.amber}44;border-radius:12px;padding:16px 20px;margin-bottom:20px">
  <div style="font-size:13px;color:${C.amber};font-weight:700;margin-bottom:8px">This proposal expires soon</div>
  <div style="font-size:13px;color:${C.sub}">Score ${proposal.analyst_score}/100 · ${minutesLeft} minutes remaining · No action taken yet</div>
</div>

${proposal.thesis ? `
<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:16px 20px;margin-bottom:20px">
  <div style="font-size:9px;color:${C.accent};text-transform:uppercase;letter-spacing:0.12em;font-weight:700;margin-bottom:8px">Thesis Reminder</div>
  <div style="font-size:13px;color:${C.sub};line-height:1.8">${proposal.thesis.slice(0, 400)}${proposal.thesis.length > 400 ? "…" : ""}</div>
</div>` : ""}

<div style="text-align:center;margin-bottom:24px">
  ${btn("→ Review Now", DASHBOARD, C.amber, C.amberBg)}
</div>

<div style="font-size:10px;color:${C.muted}">Kairos · Proposal #${proposal.id} · If no action, proposal expires and is discarded.</div>
`);

  await getEmailProvider().send({ from: FROM, to: ADMIN_EMAIL, subject, html });
}

// ── outcome email (7 days post-fill) ─────────────────────────────────────────

export async function sendTradeOutcomeEmail(opts: {
  symbol: string;
  side: string;
  qty: number;
  fillPrice: number;
  currentPrice: number;
  proposalId?: number;
  pnlPct: number;
  holdDays: number;
  agentScore: number;
  exitReason?: string;
}): Promise<void> {

  const pnlPositive = opts.pnlPct >= 0;
  const pnlEmoji    = pnlPositive ? "📈" : "📉";
  const pnlColor    = pnlPositive ? C.green : C.red;
  const pnlBg       = pnlPositive ? C.greenBg : C.redBg;
  const subject     = `${pnlEmoji} Outcome: ${opts.symbol} ${pnlPositive ? "+" : ""}${opts.pnlPct.toFixed(1)}% in ${opts.holdDays}d`;

  const html = wrap(`
${header(pnlEmoji, `${opts.symbol} Trade Outcome`, `${opts.holdDays} days after ${opts.side} signal`)}

<div style="background:${pnlBg};border:1px solid ${pnlColor}44;border-radius:12px;padding:18px 20px;margin-bottom:20px">
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
    <div><div style="font-size:9px;color:${C.muted};text-transform:uppercase;margin-bottom:4px">Entry Price</div><div style="font-size:18px;font-weight:700">$${opts.fillPrice.toFixed(2)}</div></div>
    <div><div style="font-size:9px;color:${C.muted};text-transform:uppercase;margin-bottom:4px">Current Price</div><div style="font-size:18px;font-weight:700">$${opts.currentPrice.toFixed(2)}</div></div>
    <div><div style="font-size:9px;color:${C.muted};text-transform:uppercase;margin-bottom:4px">Return</div><div style="font-size:18px;font-weight:700;color:${pnlColor}">${pnlPositive ? "+" : ""}${opts.pnlPct.toFixed(2)}%</div></div>
  </div>
</div>

<div style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:14px 18px;margin-bottom:16px">
  <div style="font-size:12px;color:${C.sub};line-height:1.8">
    <strong>Original signal score:</strong> ${opts.agentScore}/100<br>
    <strong>Hold period:</strong> ${opts.holdDays} day${opts.holdDays !== 1 ? "s" : ""}<br>
    ${opts.exitReason ? `<strong>Exit reason:</strong> ${opts.exitReason}<br>` : ""}
    <strong>Result:</strong> ${pnlPositive ? `Trade worked — LearnerAgent will note this as a win` : `Trade failed — LearnerAgent will analyze what signals missed this`}
  </div>
</div>

<div style="text-align:center;margin-bottom:20px">
  ${btn("→ View in Dashboard", DASHBOARD, C.accent, "#1E1F3A")}
</div>

<div style="font-size:10px;color:${C.muted}">Kairos · ${opts.proposalId ? `Proposal #${opts.proposalId} · ` : ""}Past performance is not indicative of future results.</div>
`);

  await getEmailProvider().send({ from: FROM, to: ADMIN_EMAIL, subject, html });
}
