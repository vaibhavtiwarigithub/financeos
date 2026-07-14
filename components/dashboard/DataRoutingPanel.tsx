"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EVIDENCE_INTENTS,
  INTENT_CATALOG,
  type EvidenceIntent,
  type Market,
  type PolicyMode,
} from "@/lib/evidence/contracts";

// Canonical Evidence Router — "Routing Policy" owner UI (Settings → Data).
//
// Reads /api/settings/data-routing (GET) for the active version, its rules, the
// code-owned effective Auto chain per intent, provider availability, the latest
// unactivated draft, and version history. Edits are staged locally into a full
// per-intent matrix and written back via:
//   POST /versions      → creates a new UNACTIVATED version (Save)
//   POST /activate       → swaps the active pointer to the latest version (Activate)
//   POST /restore-auto   → creates + activates an all-Auto version (Restore Auto)
// Deterministic, additive, owner-only. NO scoring / order / money path is touched —
// the router itself is still shadow (router_enabled=false), so activating a policy
// records intent but does not yet change live research.

const T = {
  card: "#1A1D27", surface: "#13151C", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#F59E0B", amberBg: "#2D2000",
};

const MODES: readonly PolicyMode[] = ["auto", "prefer", "only", "off"];

// Human-readable names for each canonical intent (mirrors contracts order).
const INTENT_LABELS: Record<EvidenceIntent, string> = {
  "price.quote": "Price — live quote",
  "price.daily_bars": "Price — daily bars",
  "fundamentals.reported": "Fundamentals — reported",
  "fundamentals.valuation": "Fundamentals — valuation",
  "analyst.consensus": "Analyst — consensus",
  "sentiment.news": "Sentiment — news",
  "insider.transactions": "Insider — transactions",
  "events.earnings": "Events — earnings",
  "events.corporate_actions": "Events — corporate actions",
  "macro.regime_inputs": "Macro — regime inputs",
};

const MODE_HELP: Record<PolicyMode, string> = {
  auto: "Router picks the default provider chain and falls back automatically.",
  prefer: "Try the chosen provider first, then fall back to the Auto chain.",
  only: "Use only the chosen provider — no fallback; unavailable if it fails.",
  off: "Skip this dimension entirely — the scorer treats it as not-applicable.",
};

type Row = {
  intent: EvidenceIntent;
  mode: PolicyMode;
  preferred_provider: string | null;
  max_age_seconds: number;
  stale_max_seconds: number;
  max_sync_attempts: number;
};

type EffectiveChain = { intent: EvidenceIntent; providers: string[]; allowedProviders: string[] };
type ProviderInfo = { id: string; label: string; transport: string; markets: string[]; official: boolean; entitlementRequired: boolean; trustTier: number };
type VersionRow = { id: string; version: number; router_enabled: boolean; created_at: string; change_note: string | null; is_active: boolean };

type RoutingPayload = {
  market: Market;
  active: {
    id: string; version: number; router_enabled: boolean; created_at: string;
    change_note: string | null; activated_at: string | null;
    rules: Array<{
      intent: EvidenceIntent; mode: PolicyMode; preferred_provider: string | null;
      max_age_seconds: number | null; stale_max_seconds: number | null; max_sync_attempts: number | null;
    }>;
  } | null;
  effectiveChains: EffectiveChain[];
  providers: ProviderInfo[];
  latestUnactivated: { id: string; version: number; created_at: string; change_note: string | null } | null;
  history: VersionRow[];
  as_of: string;
};

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds === 0) return "no stale";
  const d = seconds / 86400;
  if (d >= 1 && Number.isInteger(d)) return `${d}d`;
  const h = seconds / 3600;
  if (h >= 1 && Number.isInteger(h)) return `${h}h`;
  const m = seconds / 60;
  if (m >= 1 && Number.isInteger(m)) return `${m}m`;
  return `${seconds}s`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function DataRoutingPanel() {
  const [market, setMarket] = useState<Market>("us");
  const [data, setData] = useState<RoutingPayload | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const seedRows = useCallback((payload: RoutingPayload): Row[] => {
    const byIntent = new Map(payload.active?.rules?.map((r) => [r.intent, r]) ?? []);
    return EVIDENCE_INTENTS.map((intent) => {
      const spec = INTENT_CATALOG[intent];
      const r = byIntent.get(intent);
      if (r) {
        return {
          intent,
          mode: r.mode,
          preferred_provider: r.preferred_provider ?? null,
          max_age_seconds: r.max_age_seconds ?? spec.freshTtlSeconds,
          stale_max_seconds: r.stale_max_seconds ?? spec.staleCeilingSeconds,
          max_sync_attempts: r.max_sync_attempts ?? 2,
        };
      }
      // No active rule yet → seed from the code-owned intent catalog defaults.
      return {
        intent,
        mode: "auto" as PolicyMode,
        preferred_provider: null,
        max_age_seconds: spec.freshTtlSeconds,
        stale_max_seconds: spec.staleCeilingSeconds,
        max_sync_attempts: 2,
      };
    });
  }, []);

  const load = useCallback(async (mkt: Market) => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/settings/data-routing?market=${mkt}`);
      const payload = (await res.json()) as RoutingPayload;
      if (!res.ok) throw new Error((payload as unknown as { error?: string }).error ?? "Failed to load routing policy");
      setData(payload);
      setRows(seedRows(payload));
      setNote("");
    } catch (e) {
      setData(null);
      setRows([]);
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Failed to load routing policy" });
    } finally {
      setLoading(false);
    }
  }, [seedRows]);

  useEffect(() => { load(market); }, [market, load]);

  const chainByIntent = useMemo(() => {
    const m = new Map<EvidenceIntent, EffectiveChain>();
    for (const c of data?.effectiveChains ?? []) m.set(c.intent, c);
    return m;
  }, [data]);

  const labelFor = useCallback((id: string): string => {
    return data?.providers.find((p) => p.id === id)?.label ?? id;
  }, [data]);

  function patchRow(intent: EvidenceIntent, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => {
      if (r.intent !== intent) return r;
      const next = { ...r, ...patch };
      // auto/off must not carry a preferred provider (matches the API contract).
      if (next.mode === "auto" || next.mode === "off") next.preferred_provider = null;
      return next;
    }));
  }

  // ── Mutations ────────────────────────────────────────────────────────────
  async function onSave() {
    // Client-side mirror of the API validation so we fail fast with a clear reason.
    for (const r of rows) {
      if ((r.mode === "prefer" || r.mode === "only") && !r.preferred_provider) {
        setMsg({ kind: "err", text: `“${INTENT_LABELS[r.intent]}” is set to ${r.mode} but has no preferred provider chosen. Pick one, or switch it back to Auto.` });
        return;
      }
    }
    const ok = window.confirm(
      `Save a NEW routing-policy version for ${market.toUpperCase()} with all ${rows.length} intents?\n\n` +
      `This creates an UNACTIVATED draft — nothing changes for live research until you press Activate. ` +
      `The router is still in shadow mode, so even after activation no orders or scoring are affected.`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const body = {
        market,
        change_note: note.trim() || null,
        rules: rows.map((r) => {
          const stale = Math.max(r.stale_max_seconds, r.max_age_seconds); // enforce stale >= fresh
          return {
            intent: r.intent,
            mode: r.mode,
            preferred_provider: r.mode === "prefer" || r.mode === "only" ? r.preferred_provider : null,
            max_age_seconds: r.max_age_seconds,
            stale_max_seconds: stale,
            max_sync_attempts: r.max_sync_attempts,
          };
        }),
      };
      const res = await fetch("/api/settings/data-routing/versions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Save failed");
      setMsg({ kind: "ok", text: "Saved as a new unactivated draft. Review it below, then press Activate to make it the active policy." });
      await load(market);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally { setBusy(false); }
  }

  async function onActivate() {
    const draft = data?.latestUnactivated;
    if (!draft) return;
    const ok = window.confirm(
      `Activate version ${draft.version} for ${market.toUpperCase()}?\n\n` +
      `This swaps the active-policy pointer to the latest draft. Because the router is in shadow mode ` +
      `(router_enabled=false), this records the change but does NOT yet affect live research, scoring, or orders.`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/data-routing/activate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, version_id: draft.id }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Activate failed");
      setMsg({ kind: "ok", text: `Version ${draft.version} is now the active policy for ${market.toUpperCase()}. It stays inert until the router is switched on.` });
      await load(market);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Activate failed" });
    } finally { setBusy(false); }
  }

  async function onRestoreAuto() {
    const ok = window.confirm(
      `Restore the all-Auto safe default for ${market.toUpperCase()}?\n\n` +
      `This creates AND activates a fresh version with every intent set to Auto (router picks the default ` +
      `provider chain). Your current draft edits in this table will be discarded. No orders or scoring are affected.`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/data-routing/restore-auto", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Restore failed");
      setMsg({ kind: "ok", text: `All intents reset to Auto and activated for ${market.toUpperCase()}.` });
      await load(market);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Restore failed" });
    } finally { setBusy(false); }
  }

  // Per-row status sentence — detail over cryptic, never a bare token.
  function statusFor(r: Row): { text: string; color: string } {
    const chain = chainByIntent.get(r.intent);
    const applicable = INTENT_CATALOG[r.intent].markets.includes(market);
    const marketChain = chain?.providers ?? [];
    if (!applicable) return { text: `Not offered for ${market === "india" ? "India" : "US"} — will resolve as unavailable.`, color: T.muted };
    if (r.mode === "off") return { text: "Off — this dimension is skipped in research.", color: T.muted };
    if (r.mode === "auto") {
      if (marketChain.length === 0) return { text: "Auto, but no provider serves this market — will be unavailable.", color: T.amber };
      return { text: `Auto — falls back through ${marketChain.length} provider${marketChain.length > 1 ? "s" : ""}.`, color: T.green };
    }
    const pref = r.preferred_provider ? labelFor(r.preferred_provider) : "(none)";
    const servesMarket = r.preferred_provider ? marketChain.includes(r.preferred_provider) : false;
    if (r.mode === "prefer") {
      return servesMarket
        ? { text: `Prefer ${pref} — falls back to the Auto chain if it fails.`, color: T.green }
        : { text: `Prefer ${pref}, but it doesn't serve this market — Auto chain will be used.`, color: T.amber };
    }
    // only
    return servesMarket
      ? { text: `Only ${pref} — no fallback; unavailable if it fails.`, color: T.amber }
      : { text: `Only ${pref}, but it doesn't serve this market — this dimension will be unavailable.`, color: T.red };
  }

  const routerEnabled = data?.active?.router_enabled ?? false;
  const draft = data?.latestUnactivated ?? null;

  const th: React.CSSProperties = { padding: "10px 12px", position: "sticky", top: 0, background: T.surface, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "10px 12px", borderTop: `1px solid ${T.border}`, verticalAlign: "top" };
  const ctrl: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, padding: "6px 8px", outline: "none" };

  return (
    <div style={{ maxWidth: 1100 }}>
      {/* Header / intent */}
      <div style={{ fontSize: 13, color: T.sub, marginBottom: 14, lineHeight: 1.55 }}>
        <strong style={{ color: T.text }}>Routing Policy</strong> — for each canonical evidence intent, choose how the
        Canonical Evidence Router selects a data provider. Agents only ever request an intent; the router owns provider
        choice, fallback, cache freshness, and provenance. Edit the matrix below, <em>Save</em> a draft, then <em>Activate</em> it.
      </div>

      {/* Shadow-mode banner (prominent) */}
      <div style={{ background: T.amberBg, border: `1px solid ${T.amber}`, borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 13, color: T.amber, lineHeight: 1.5 }}>
        <strong>Shadow mode — router is disabled (router_enabled={String(routerEnabled)}).</strong>{" "}
        Policy changes are recorded and versioned, but they do <strong>not</strong> affect live research, scoring, or
        orders yet. This screen lets you stage and review the routing policy ahead of the router cut-over.
      </div>

      {/* Market tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["us", "india"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMarket(m)}
            disabled={busy}
            style={{
              background: market === m ? T.accentBg : "transparent",
              border: `1px solid ${market === m ? T.accent : T.border}`,
              color: market === m ? T.accent : T.sub,
              borderRadius: 8, padding: "7px 18px", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer",
            }}
          >
            {m === "us" ? "🇺🇸 US" : "🇮🇳 India"}
          </button>
        ))}
      </div>

      {/* Status message */}
      {msg && (
        <div style={{ fontSize: 13, borderRadius: 8, padding: "10px 14px", marginBottom: 14, lineHeight: 1.5, color: msg.kind === "ok" ? T.green : T.red, background: T.surface, border: `1px solid ${msg.kind === "ok" ? T.green : T.red}` }}>
          {msg.text}
        </div>
      )}

      {loading && <div style={{ color: T.muted, fontSize: 14, padding: "12px 0" }}>Loading routing policy…</div>}

      {!loading && data && (
        <>
          {/* Active version summary */}
          <div style={{ fontSize: 12, color: T.sub, marginBottom: 12 }}>
            {data.active
              ? <>Active policy: <strong style={{ color: T.text }}>version {data.active.version}</strong>{data.active.change_note ? ` — “${data.active.change_note}”` : ""} · activated {fmtWhen(data.active.activated_at)}.</>
              : <>No active policy for this market yet — the table below is seeded from code defaults (all Auto). Save to create version 1.</>}
            {draft && <span style={{ color: T.amber }}> · Unactivated draft available: version {draft.version}.</span>}
          </div>

          {/* Matrix — horizontal scroll container so the page body never overflows on mobile */}
          <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 12, marginBottom: 16 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 860 }}>
              <thead>
                <tr style={{ background: T.surface, color: T.muted, textAlign: "left" }}>
                  <th style={th}>Intent</th>
                  <th style={th}>Mode</th>
                  <th style={th}>Preferred provider</th>
                  <th style={th}>Effective chain</th>
                  <th style={th}>Freshness (TTL)</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const chain = chainByIntent.get(r.intent);
                  const options = chain?.allowedProviders ?? [];
                  const marketChain = chain?.providers ?? [];
                  const preferEnabled = r.mode === "prefer" || r.mode === "only";
                  const st = statusFor(r);
                  return (
                    <tr key={r.intent} style={{ color: T.text }}>
                      <td style={td}>
                        <div style={{ fontWeight: 600 }}>{INTENT_LABELS[r.intent]}</div>
                        <div style={{ fontSize: 10, color: T.muted, fontFamily: "monospace", marginTop: 2 }}>{r.intent}</div>
                      </td>
                      <td style={td}>
                        <select value={r.mode} onChange={(e) => patchRow(r.intent, { mode: e.target.value as PolicyMode })} style={{ ...ctrl, cursor: "pointer" }} title={MODE_HELP[r.mode]}>
                          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </td>
                      <td style={td}>
                        <select
                          value={r.preferred_provider ?? ""}
                          disabled={!preferEnabled}
                          onChange={(e) => patchRow(r.intent, { preferred_provider: e.target.value || null })}
                          style={{ ...ctrl, cursor: preferEnabled ? "pointer" : "not-allowed", opacity: preferEnabled ? 1 : 0.4, minWidth: 130 }}
                        >
                          <option value="">{preferEnabled ? "— choose provider —" : "n/a"}</option>
                          {options.map((id) => (
                            <option key={id} value={id}>{labelFor(id)}{marketChain.includes(id) ? "" : " (other market)"}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ ...td, color: T.sub, minWidth: 150 }}>
                        {marketChain.length
                          ? marketChain.map((id) => labelFor(id)).join(" → ")
                          : <span style={{ color: T.muted }}>no provider for this market</span>}
                      </td>
                      <td style={td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="number" min={0} value={r.max_age_seconds}
                            onChange={(e) => patchRow(r.intent, { max_age_seconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                            style={{ ...ctrl, width: 92, textAlign: "right" }}
                            title="max_age_seconds — serve from cache without a live call within this age"
                          />
                          <span style={{ fontSize: 11, color: T.muted, whiteSpace: "nowrap" }}>{fmtDuration(r.max_age_seconds)}</span>
                        </div>
                        <div style={{ fontSize: 10, color: T.muted, marginTop: 3 }}>stale ≤ {fmtDuration(Math.max(r.stale_max_seconds, r.max_age_seconds))}</div>
                      </td>
                      <td style={{ ...td, minWidth: 200 }}>
                        <span style={{ color: st.color }}>{st.text}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Change note + action buttons */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginBottom: 20 }}>
            <div style={{ flex: "1 1 260px" }}>
              <label style={{ fontSize: 11, color: T.muted, display: "block", marginBottom: 5 }}>Change note (optional — recorded on the version)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Prefer Webull for US analyst consensus" style={{ ...ctrl, width: "100%", padding: "8px 10px" }} />
            </div>
            <button
              onClick={onSave} disabled={busy}
              style={{ background: T.accent, border: "none", borderRadius: 8, color: "#fff", padding: "10px 22px", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
              title="Create a new unactivated policy version from the matrix above. Does not affect live research."
            >
              {busy ? "Working…" : "Save draft"}
            </button>
            <button
              onClick={onActivate} disabled={busy || !draft}
              style={{ background: draft ? "transparent" : T.surface, border: `1px solid ${draft ? T.green : T.border}`, borderRadius: 8, color: draft ? T.green : T.muted, padding: "10px 22px", fontSize: 13, fontWeight: 600, cursor: busy || !draft ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
              title={draft ? `Activate the latest unactivated draft (version ${draft.version}).` : "No unactivated draft — Save one first."}
            >
              {draft ? `Activate v${draft.version}` : "Activate (no draft)"}
            </button>
            <button
              onClick={onRestoreAuto} disabled={busy}
              style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: 8, color: T.sub, padding: "10px 22px", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
              title="Create and activate a fresh all-Auto version — the safe default."
            >
              Restore Auto
            </button>
          </div>

          {/* Version history */}
          <div style={{ fontSize: 12, fontWeight: 700, color: T.muted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>Recent versions</div>
          {data.history.length === 0 ? (
            <div style={{ color: T.muted, fontSize: 13 }}>No versions yet for this market. Save a draft to create version 1.</div>
          ) : (
            <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 520 }}>
                <thead>
                  <tr style={{ background: T.surface, color: T.muted, textAlign: "left" }}>
                    <th style={{ padding: "9px 12px" }}>Version</th>
                    <th style={{ padding: "9px 12px" }}>Status</th>
                    <th style={{ padding: "9px 12px" }}>Created</th>
                    <th style={{ padding: "9px 12px" }}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((v) => (
                    <tr key={v.id} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
                      <td style={{ padding: "9px 12px", fontWeight: 600 }}>v{v.version}</td>
                      <td style={{ padding: "9px 12px" }}>
                        {v.is_active
                          ? <span style={{ color: T.green }}>● Active</span>
                          : draft && draft.id === v.id
                            ? <span style={{ color: T.amber }}>◍ Unactivated draft</span>
                            : <span style={{ color: T.muted }}>Superseded</span>}
                      </td>
                      <td style={{ padding: "9px 12px", color: T.sub, whiteSpace: "nowrap" }}>{fmtWhen(v.created_at)}</td>
                      <td style={{ padding: "9px 12px", color: T.sub }}>{v.change_note || <span style={{ color: T.muted }}>—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: 11, color: T.muted, marginTop: 12 }}>
            Owner-only. Versions are immutable — every Save creates a new one, and history above is the audit trail (who/when is recorded server-side). Snapshot as of {fmtWhen(data.as_of)}.
          </div>
        </>
      )}
    </div>
  );
}
