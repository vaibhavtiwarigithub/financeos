import PageHeader from "@/components/dashboard/PageHeader";
import WatchlistPanel from "@/components/dashboard/WatchlistPanel";

export default function WatchlistPage() {
  return (
    <div style={{ color: "#ECEDEF", fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: "#0D0F14" }}>
      <PageHeader
        title="Watchlist"
        subtitle="Tracked symbols · scored daily by ResearchAgent"
        cadence="daily"
        whatItDoes="Every symbol with Research enabled gets scored by ResearchAgent at 9 AM. Scores ≥60 generate a signal. PaperTrader acts on signals automatically."
        whatToLookFor={[
          "Research toggle ON = agent scores it tomorrow 9 AM",
          "Signal alert = get notified when score ≥60 fires",
          "Earnings alert = get notified day before earnings",
          "AI Scout symbols (purple) auto-expire after 7 days unless you keep them",
        ]}
      />
      <div style={{ padding: "0 28px 40px" }}>
        <WatchlistPanel />
      </div>
    </div>
  );
}
