"use client";
import { useEffect, useRef, useState, CSSProperties } from "react";

// Shared ticker-autocomplete input. Drop this anywhere a user types a symbol so
// every symbol field behaves the same: debounced lookup against
// /api/symbols/search, keyboard + click select, click-outside to dismiss.
//
// Controlled: parent owns the string via `value`/`onChange`. `onSelect` fires
// when the user picks a suggestion (or presses Enter on the raw text), giving
// the parent the clean uppercased symbol to act on.

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", surface: "#0F1117",
};

type SymbolResult = { symbol: string; name: string; exchange: string; locale: string };

export default function SymbolAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = "Search ticker (e.g. NVDA)…",
  inputStyle,
  autoFocus,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect?: (symbol: string) => void;
  placeholder?: string;
  inputStyle?: CSSProperties;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  const [suggestions, setSuggestions] = useState<SymbolResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced lookup (250ms). Silent on failure — the field still works as a
  // plain input if the provider is down.
  useEffect(() => {
    const q = value.trim();
    if (q.length < 1) { setSuggestions([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/symbols/search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        setSuggestions(Array.isArray(d.results) ? d.results.slice(0, 8) : []);
      } catch {
        setSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [value]);

  // Click outside → close the dropdown.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(sym: string) {
    const clean = sym.trim().toUpperCase();
    onChange(clean);
    setOpen(false);
    setActive(-1);
    setSuggestions([]);
    onSelect?.(clean);
  }

  const showList = open && suggestions.length > 0;

  return (
    <div ref={boxRef} style={{ position: "relative", width: "100%" }}>
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={e => { onChange(e.target.value.toUpperCase()); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (!showList) {
            if (e.key === "Enter") onEnter?.();
            return;
          }
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, suggestions.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          else if (e.key === "Enter") {
            e.preventDefault();
            if (active >= 0 && active < suggestions.length) pick(suggestions[active].symbol);
            else { setOpen(false); onEnter?.(); }
          } else if (e.key === "Escape") { setOpen(false); }
        }}
        placeholder={placeholder}
        style={{
          width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: "8px", padding: "8px 12px", color: T.text, fontSize: "14px", outline: "none",
          ...inputStyle,
        }}
      />
      {showList && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 60,
          background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px",
          overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {suggestions.map((s, i) => (
            <div
              key={`${s.symbol}-${s.exchange}`}
              onMouseDown={e => { e.preventDefault(); pick(s.symbol); }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: "flex", alignItems: "center", gap: "8px", padding: "7px 10px", cursor: "pointer",
                borderBottom: `1px solid ${T.border}22`,
                background: i === active ? T.surface : "transparent",
              }}
            >
              <span style={{ fontSize: "12px", fontWeight: 700, color: T.text, minWidth: "46px" }}>{s.symbol}</span>
              <span style={{ fontSize: "11px", color: T.textSub, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.name || "—"}
              </span>
              {s.exchange && (
                <span style={{ fontSize: "9px", fontWeight: 700, color: T.muted, background: T.surface, padding: "1px 5px", borderRadius: "3px", whiteSpace: "nowrap" }}>
                  {s.exchange}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
