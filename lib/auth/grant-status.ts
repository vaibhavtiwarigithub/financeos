// The one place a guest grant's status is decided.
//
// The access page used to render `active = !revoked_at` and nothing else, which
// conflated three genuinely different situations into one green "Active":
//
//   1. They accepted the invitation and can sign in.
//   2. The invitation was sent and is sitting unopened.
//   3. The invitation bounced. Nobody ever received it, and nobody ever will.
//
// (3) is the one that matters: a typo'd address showed as ACTIVE on the page
// whose only job is answering "who can see my book?".
//
// ACCESS AND DELIVERY ARE SEPARATE AXES and are deliberately not collapsed
// into a single enum here. A bounce is a fact about an EMAIL, not about a
// person's standing: someone who already accepted and whose mailbox later
// fills up still has access, and showing them as "undeliverable" instead of
// "Active" would be a second lie in the other direction. So `state` answers
// "what is their access?" and `deliveryProblem` answers "did our mail arrive?",
// and the UI shows both.

export type GrantState = "active" | "pending" | "revoked";
export type DeliveryKind = "bounced" | "complained";

export interface GrantStatusInput {
  revoked_at: string | null;
  /**
   * `auth.users.confirmed_at`. READ from Supabase, never copied into
   * `app_user_roles` — Supabase owns acceptance and a second copy would drift.
   * Null means the invitation link has not been used.
   */
  confirmed_at: string | null;
  undeliverable_at: string | null;
  undeliverable_kind: string | null;
  undeliverable_note: string | null;
}

export interface GrantStatus {
  state: GrantState;
  /** Did they use the invitation link and set a password? */
  accepted: boolean;
  /**
   * Whether this person can actually reach the app right now. A pending grant
   * carries no password, so the answer is no even though nothing is revoked.
   */
  canSignIn: boolean;
  label: string;
  tone: "good" | "warn" | "bad" | "muted";
  /** Null when mail is fine. Independent of `state` — see the note above. */
  deliveryProblem: { kind: DeliveryKind; at: string; note: string | null } | null;
}

function deliveryOf(g: GrantStatusInput): GrantStatus["deliveryProblem"] {
  if (!g.undeliverable_at) return null;
  const kind: DeliveryKind = g.undeliverable_kind === "complained" ? "complained" : "bounced";
  return { kind, at: g.undeliverable_at, note: g.undeliverable_note ?? null };
}

export function grantStatus(g: GrantStatusInput): GrantStatus {
  const deliveryProblem = deliveryOf(g);
  const accepted = Boolean(g.confirmed_at);

  if (g.revoked_at) {
    // Revoked outranks everything for display: whatever happened to the mail,
    // the answer to "can they see my book?" is no.
    return {
      state: "revoked", accepted, canSignIn: false,
      label: `Revoked ${g.revoked_at.slice(0, 10)}`, tone: "muted", deliveryProblem,
    };
  }

  if (!accepted) {
    if (deliveryProblem?.kind === "bounced") {
      return {
        state: "pending", accepted: false, canSignIn: false,
        label: "Invite bounced — never delivered", tone: "bad", deliveryProblem,
      };
    }
    if (deliveryProblem?.kind === "complained") {
      return {
        state: "pending", accepted: false, canSignIn: false,
        label: "Invite marked as spam", tone: "warn", deliveryProblem,
      };
    }
    return {
      state: "pending", accepted: false, canSignIn: false,
      label: "Invited — not yet accepted", tone: "warn", deliveryProblem,
    };
  }

  // Accepted. They can sign in, and a later mail problem does not change that.
  return { state: "active", accepted: true, canSignIn: true, label: "Active", tone: "good", deliveryProblem };
}

/** One line for a delivery problem, or null. Shared by the page and any alerting. */
export function deliveryProblemText(p: GrantStatus["deliveryProblem"]): string | null {
  if (!p) return null;
  const when = p.at.slice(0, 10);
  const head = p.kind === "bounced"
    ? `Email bounced ${when} — the address does not accept mail`
    : `Marked as spam ${when} — mail is being delivered but filtered`;
  return p.note ? `${head} (${p.note})` : head;
}
