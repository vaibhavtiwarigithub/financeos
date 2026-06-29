export default function Loading() {
  return (
    <div style={{ padding: "28px", display: "flex", flexDirection: "column", gap: "16px" }}>
      {[1, 2, 3].map(i => (
        <div key={i} style={{ background: "#1A1D27", borderRadius: "12px", height: i === 1 ? "120px" : "80px", animation: "pulse 1.5s ease-in-out infinite", opacity: 1 - i * 0.15 }} />
      ))}
      <style>{`@keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:.8} }`}</style>
    </div>
  );
}
