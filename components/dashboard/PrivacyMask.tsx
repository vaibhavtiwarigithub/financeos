"use client";
import { useState, useEffect } from "react";

const STORAGE_KEY = "kairos-privacy-enabled";

// Master on/off switch (Settings page). Defaults ON — numbers hidden by
// default until this is explicitly turned off.
export function isPrivacyEnabled(): boolean {
  if (typeof window === "undefined") return true;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === null ? true : v === "true";
}

export function setPrivacyEnabled(enabled: boolean) {
  window.localStorage.setItem(STORAGE_KEY, String(enabled));
  window.dispatchEvent(new Event("kairos-privacy-changed"));
}

export function usePrivacySetting(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    setEnabled(isPrivacyEnabled());
    const onChange = () => setEnabled(isPrivacyEnabled());
    window.addEventListener("kairos-privacy-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("kairos-privacy-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return [enabled, (v: boolean) => setPrivacyEnabled(v)];
}

// Per-view reveal state. Plain useState (not persisted) is intentional —
// each mount starts masked again, so navigating away and back re-hides
// numbers automatically, without any extra logic needed.
export function useRevealToggle() {
  const [privacyEnabled] = usePrivacySetting();
  const [revealed, setRevealed] = useState(false);
  const masked = privacyEnabled && !revealed;
  return { masked, revealed, setRevealed, privacyEnabled };
}

export function maskText(value: string, masked: boolean): string {
  return masked ? "••••••" : value;
}

const T = { border: "#252836", text: "#ECEDEF", muted: "#6B7280", accent: "#6366F1" };

export function EyeToggle({ masked, onToggle, size = 13 }: { masked: boolean; onToggle: () => void; size?: number }) {
  return (
    <button
      onClick={onToggle}
      title={masked ? "Show numbers" : "Hide numbers"}
      style={{
        background: "none", border: `1px solid ${T.border}`, borderRadius: "6px",
        color: masked ? T.muted : T.accent, cursor: "pointer",
        padding: "3px 7px", fontSize: `${size}px`, lineHeight: 1, display: "inline-flex", alignItems: "center", gap: "4px",
      }}
    >
      {masked ? "👁" : "🙈"} {masked ? "Show" : "Hide"}
    </button>
  );
}
