function classifyOutput(text) {
  const out = String(text);
  if (/No claimable job/i.test(out)) return { kind: "idle" };
  const status = [...out.matchAll(/"outcome":"([a-z_]+)"/g)].map((m) => m[1]).at(-1);
  if (status === "quota_exhausted" || status === "subscription_quota_or_capacity") return { kind: "pause", ownerAction: true, why: status };
  if (status === "authentication_required") return { kind: "pause", ownerAction: true, why: "authentication_required" };
  if (status === "model_unavailable" || status === "invalid_client_configuration") return { kind: "pause", ownerAction: true, why: status };
  if (status) return { kind: "job", outcome: status };
  return { kind: "error" };
}

module.exports = { classifyOutput };
