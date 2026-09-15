"use client";
import { useEffect, useState } from "react";

export type ClientRole = "owner" | "viewer" | null;

// One request per page load, shared by every component that asks.
let cached: Promise<ClientRole> | null = null;

function loadRole(): Promise<ClientRole> {
  cached ??= fetch("/api/auth/role")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d?.role === "owner" || d?.role === "viewer" ? d.role : null))
    .catch(() => null);
  return cached;
}

/**
 * The signed-in role, or `undefined` while it loads.
 *
 * PRESENTATION ONLY: it decides which buttons and requests a page shows, so a
 * viewer is not offered owner-only actions that would 403. Every route enforces
 * access itself regardless of what this returns.
 */
export function useRole(): ClientRole | undefined {
  const [role, setRole] = useState<ClientRole | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadRole().then((r) => { if (live) setRole(r); });
    return () => { live = false; };
  }, []);
  return role;
}
