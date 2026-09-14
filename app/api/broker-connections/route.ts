// A signed-in user's OWN broker connections: state, and disconnect.
//
// Own-data route (see VIEWER_OWN_DATA_ROUTES): it writes, but only rows keyed to
// the caller. It never reads or writes the owner's data and never a shared
// table, so the shared-read cost guarantee is untouched.
//
// The ciphertext is never returned — `guestConnectionStates` reads only the
// non-secret columns. There is no endpoint, here or anywhere, that hands a
// broker token back to a browser.
import { NextRequest, NextResponse } from "next/server";
import { getSessionRole } from "@/lib/auth/session-role";
import {
  guestConnectionStates,
  disconnectGuestCredential,
  type GuestBroker,
} from "@/lib/brokers/guest-credentials";
import { credentialEncryptionAvailable } from "@/lib/security/credential-cipher";

export const dynamic = "force-dynamic";

const BROKERS: GuestBroker[] = ["robinhood", "kite"];

export async function GET() {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    connections: await guestConnectionStates(userId),
    // Surfaced so the UI can say "not configured" rather than offering a
    // Connect button that would fail at the last step.
    encryption_ready: credentialEncryptionAvailable(),
    // Robinhood arrives in a later phase; the UI shows it as coming soon rather
    // than pretending it works.
    supported: { kite: true, robinhood: false },
  });
}

export async function POST(req: NextRequest) {
  const { role, userId } = await getSessionRole();
  if (!role || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  if (String(body?.action ?? "") !== "disconnect") {
    return NextResponse.json({ error: "action must be disconnect" }, { status: 400 });
  }
  const broker = String(body?.broker ?? "") as GuestBroker;
  if (!BROKERS.includes(broker)) {
    return NextResponse.json({ error: "broker must be robinhood|kite" }, { status: 400 });
  }

  // Scoped to the CALLER's own row — the user id comes from the session, never
  // from the request body, so one user cannot disconnect another's broker.
  await disconnectGuestCredential(userId, broker);

  return NextResponse.json({ ok: true, connections: await guestConnectionStates(userId) });
}
