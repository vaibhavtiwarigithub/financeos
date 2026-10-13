"use client";

import { useEffect, useState } from "react";

// LLM council (shadow) scores for one symbol, for owner AND viewer. Stored forecasts only (/api/research/council reads
// llm_council_runs + llm_council_model_forecasts), so opening a symbol never calls a model. Nothing here feeds a trade.

type Member = { member: "deepseek" | "claude" | "codex" | null; model: string; score: number | null; confidence: number | null; rationale: string | null; bull: string | null; bear: string | null; availableAt: string | null };
type Run = { id: string; decisionTs: string; status: string; consensus: number | null; deterministic: number | null; threshold: number | null; direction: string | null; completedAt: string | null; members: Member[] };
type Payload = { runs: Run[]; error?: string };

const LABEL: Record<string, string> = { deepseek: "DeepSeek", claude: "Claude", codex: "Codex" };
const ORDER = ["deepseek", "claude", "codex"] as const;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const score = (run: Run, member: (typeof ORDER)[number]) => run.members.find((m) => m.member === member)?.score ?? null;
/** Stored consensus, else the median of all three members (a backfilled run); never a median of fewer. */
function runMedian(run: Run): number | null {
  if (run.consensus != null) return run.consensus;
  const all = ORDER.map((m) => score(run, m)).filter((v): v is number => v != null);
  return all.length === 3 ? median(all) : null;
}
const fmt = (v: number | null) => (v == null ? "—" : String(Math.round(v)));
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";

export default function CouncilScoreCard({ symbol, market }: { symbol: string; market: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/research/council?symbol=${encodeURIComponent(symbol)}&market=${market}&limit=12`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setData(j); })
      .catch(() => { if (!cancelled) setData({ runs: [], error: "Council data unavailable" }); });
    return () => { cancelled = true; };
  }, [symbol, market]);

  const latest = data?.runs?.[0] ?? null;
  const med = latest ? runMedian(latest) : null;
  const memberScores = latest ? ORDER.map((m) => score(latest, m)).filter((v): v is number => v != null) : [];
  const spread = memberScores.length >= 2 ? Math.max(...memberScores) - Math.min(...memberScores) : null;
  const vsDeterministic = med != null && latest?.deterministic != null ? med - latest.deterministic : null;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="text-sm font-semibold text-muted-foreground">LLM Council · shadow scores</h2>
        <span className="text-xs text-muted-foreground">DeepSeek · Claude · Codex score every research run independently. Measurement only: no trade, score or exit reads this.</span>
      </div>

      {!data && <div className="text-xs text-muted-foreground py-3">Loading council scores…</div>}
      {data?.error && <div className="text-xs text-red-500 py-3">{data.error}</div>}
      {data && !data.error && !latest && (
        <div className="text-xs text-muted-foreground py-3">
          No council run for {symbol} yet. The council scores each new research observation shortly after the research run that produced it; it needs the next research slot.
        </div>
      )}

      {latest && (
        <>
          <div className="flex flex-wrap items-center gap-4 my-3">
            <div>
              <div className="text-xs text-muted-foreground">Council median</div>
              <div className="text-3xl font-mono font-semibold">{fmt(med)}</div>
            </div>
            {ORDER.map((m) => (
              <div key={m}>
                <div className="text-xs text-muted-foreground">{LABEL[m]}</div>
                <div className="text-xl font-mono">{fmt(score(latest, m))}</div>
              </div>
            ))}
            <div>
              <div className="text-xs text-muted-foreground">Deterministic score</div>
              <div className="text-xl font-mono">{fmt(latest.deterministic)}{latest.threshold != null && <span className="text-xs text-muted-foreground"> / thr {fmt(latest.threshold)}</span>}</div>
            </div>
            {vsDeterministic != null && (
              <div>
                <div className="text-xs text-muted-foreground">Council − deterministic</div>
                <div className="text-xl font-mono" style={{ color: vsDeterministic >= 0 ? "#10b981" : "#ef4444" }}>{vsDeterministic >= 0 ? "+" : ""}{vsDeterministic.toFixed(0)}</div>
              </div>
            )}
            {spread != null && (
              <div>
                <div className="text-xs text-muted-foreground">Member disagreement</div>
                <div className="text-xl font-mono" style={{ color: spread >= 20 ? "#f59e0b" : undefined }}>{spread.toFixed(0)} pts</div>
              </div>
            )}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            Observation {when(latest.decisionTs)} · status <span className="font-mono">{latest.status}</span>
            {latest.status !== "completed" && memberScores.length < 3 && <> · {3 - memberScores.length} member score(s) not available for this run</>}
            {latest.consensus == null && memberScores.length === 3 && <> · median computed from all three members (run finalized before the last member returned)</>}
          </div>

          <button className="text-xs underline text-muted-foreground mb-2" onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Show"} member reasoning</button>
          {open && (
            <div className="grid gap-3 md:grid-cols-3 mb-3">
              {ORDER.map((m) => {
                const f = latest.members.find((x) => x.member === m);
                return (
                  <div key={m} className="rounded-md border p-3 text-xs">
                    <div className="font-semibold mb-1">{LABEL[m]} {f?.model ? <span className="font-mono font-normal text-muted-foreground">({f.model})</span> : null}</div>
                    {f ? (
                      <>
                        <div className="mb-1">Score <span className="font-mono">{fmt(f.score)}</span>{f.confidence != null && <> · confidence <span className="font-mono">{f.confidence.toFixed(2)}</span></>}</div>
                        {f.rationale && <p className="mb-1">{f.rationale}</p>}
                        {f.bull && <p className="text-green-600 mb-1">Bull: {f.bull}</p>}
                        {f.bear && <p className="text-red-500">Bear: {f.bear}</p>}
                      </>
                    ) : <span className="text-muted-foreground">No score for this run.</span>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1 pr-3 font-normal">Observation</th><th className="pr-3 font-normal">Deterministic</th>
                  {ORDER.map((m) => <th key={m} className="pr-3 font-normal">{LABEL[m]}</th>)}<th className="pr-3 font-normal">Median</th><th className="font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {data!.runs.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-1 pr-3 whitespace-nowrap">{when(r.decisionTs)}</td>
                    <td className="pr-3 font-mono">{fmt(r.deterministic)}</td>
                    {ORDER.map((m) => <td key={m} className="pr-3 font-mono">{fmt(score(r, m))}</td>)}
                    <td className="pr-3 font-mono font-semibold">{fmt(runMedian(r))}</td>
                    <td className="font-mono">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
