import "server-only";

export type UserWatchlistRow = {
  id: string;
  symbol: string;
  market: "us" | "india";
  added_at: string;
};

type GatewayResult = { items: UserWatchlistRow[] } | { ok: true; symbol: string; market: "us" | "india" } | { ok: true };

function gatewayUrl(path: string): URL {
  const base = process.env.CLOUDFLARE_DB_GATEWAY_URL;
  if (!base) throw new Error("Cloudflare database gateway is not configured");
  const baseUrl = new URL(base);
  const url = new URL(path, baseUrl);
  if (baseUrl.protocol !== "https:" && !(process.env.NODE_ENV === "development" && baseUrl.hostname === "localhost")) {
    throw new Error("Cloudflare database gateway must use HTTPS");
  }
  if (url.origin !== baseUrl.origin) throw new Error("Cloudflare database gateway path must remain on the configured origin");
  return url;
}

async function callGateway(path: string, init: RequestInit = {}): Promise<GatewayResult> {
  const token = process.env.CLOUDFLARE_DB_GATEWAY_TOKEN;
  if (!token || token.length < 32) throw new Error("Cloudflare database gateway is not configured");
  const response = await fetch(gatewayUrl(path), {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error("Cloudflare database gateway request failed");
  return response.json() as Promise<GatewayResult>;
}

export async function listCloudflareUserWatchlist(userId: string): Promise<UserWatchlistRow[]> {
  const query = new URLSearchParams({ user_id: userId });
  const result = await callGateway(`/v1/user-watchlist?${query}`) as { items?: UserWatchlistRow[] };
  if (!Array.isArray(result.items)) throw new Error("Cloudflare database gateway returned an invalid response");
  return result.items;
}

export async function addCloudflareUserWatchlistItem(input: {
  userId: string;
  symbol: string;
  market: "us" | "india";
}): Promise<void> {
  await callGateway("/v1/user-watchlist", {
    method: "POST",
    body: JSON.stringify({ user_id: input.userId, symbol: input.symbol, market: input.market }),
  });
}

export async function removeCloudflareUserWatchlistItem(input: {
  userId: string;
  symbol: string;
  market: "us" | "india";
}): Promise<void> {
  const query = new URLSearchParams({ user_id: input.userId, symbol: input.symbol, market: input.market });
  await callGateway(`/v1/user-watchlist?${query}`, { method: "DELETE" });
}
