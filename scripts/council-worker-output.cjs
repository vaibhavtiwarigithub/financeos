function classifyOutput(text) {
  const out = String(text);
  if (/No claimable job/i.test(out)) return { kind: "idle" };
  const status = [...out.matchAll(/"outcome":"([a-z_]+)"/g)].map((m) => m[1]).at(-1);
  if (status === "quota_exhausted") return { kind: "pause", ms: 30 * 60_000, why: "quota_exhausted" };
  if (status === "authentication_required") return { kind: "pause", ms: 10 * 60_000, why: "authentication_required" };
  if (status) return { kind: "job", outcome: status };
  return { kind: "error" };
}

module.exports = { classifyOutput };
