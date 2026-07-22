export type BrokerAccountIdentity = {
  broker: string;
  accountId: string;
  nickname?: string | null;
};

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return clean || null;
}

function brokerName(broker: string): string {
  return broker === "robinhood" ? "Robinhood"
    : broker === "webull" ? "Webull"
      : broker === "kite" ? "Kite"
        : broker === "internal" ? "Paper Portfolio"
          : cleanLabel(broker) ?? "Broker";
}

export function maskedAccountId(accountId: string): string {
  const clean = String(accountId ?? "").trim();
  return clean ? `••••${clean.slice(-4)}` : "account unavailable";
}

export function brokerAccountDisplayLabel(identity: BrokerAccountIdentity): string {
  if (identity.broker === "internal") return "Paper Portfolio";
  const name = brokerName(identity.broker);
  const masked = maskedAccountId(identity.accountId);
  const nickname = cleanLabel(identity.nickname);
  return nickname ? `${nickname} · ${name} ${masked}` : `${name} ${masked}`;
}

export async function loadLatestBrokerNicknames(
  supabase: any,
  identities: Array<{ broker: string; accountId: string }>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(identities.map((identity) => identity.accountId).filter(Boolean)));
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from("live_account_snapshots")
    .select("broker,account_id,nickname,captured_at")
    .in("account_id", ids)
    .order("captured_at", { ascending: false });
  if (error) return new Map();

  const result = new Map<string, string>();
  for (const row of data ?? []) {
    const key = `${String(row.broker)}:${String(row.account_id)}`;
    const nickname = cleanLabel(row.nickname);
    if (nickname && !result.has(key)) result.set(key, nickname);
  }
  return result;
}

export function brokerAccountKey(broker: string, accountId: string): string {
  return `${broker}:${accountId}`;
}
