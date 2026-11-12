import { redirect } from "next/navigation";
import { isOwnerIdentity } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

const T = {
  bg: "#101318",
  card: "#181d25",
  border: "#29313e",
  text: "#ecf1f7",
  muted: "#a9b4c4",
};

export default async function RecoveryDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isOwnerIdentity(user?.email, user?.email_confirmed_at)) redirect("/login?error=restricted");

  const { data: signals, error } = await supabase
    .from("agent_signals")
    .select("id,symbol,market,status,created_at")
    .order("created_at", { ascending: false })
    .limit(12);

  return (
    <main style={{ minHeight: "100vh", background: T.bg, color: T.text, padding: "40px 20px" }}>
      <section style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1>Kairos</h1>
        <p style={{ color: T.muted }}>Read-only recovery dashboard</p>
        <h2>Recent research signals</h2>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
          {error ? <p role="alert">Research data is temporarily unavailable.</p>
            : !signals?.length ? <p>No research signals are available.</p>
            : <ul style={{ paddingInlineStart: 20 }}>
              {signals.map(signal => (
                <li key={signal.id} style={{ marginBlock: 8 }}>
                  <strong>{signal.symbol}</strong> {signal.market} · {signal.status} ·{" "}
                  <time dateTime={signal.created_at}>{signal.created_at?.slice(0, 10) ?? "Date unavailable"}</time>
                </li>
              ))}
            </ul>}
        </div>
      </section>
    </main>
  );
}
