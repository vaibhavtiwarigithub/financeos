import { timingSafeEqual } from "crypto";

// Timing-safe comparison of the x-cron-secret header against CRON_SECRET.
// Plain `===`/`!==` leaks length/prefix via response timing; more important,
// several routes used `header !== process.env.CRON_SECRET` which, if
// CRON_SECRET is unset, makes an empty header match (undefined !== "" is true,
// so that specific pattern rejects — but `header === process.env.CRON_SECRET`
// with both undefined/"" would PASS). This helper fails closed: an unset or
// empty CRON_SECRET can never be satisfied by any request.
export function verifyCronSecret(req: { headers: { get(name: string): string | null } }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — never accept when unconfigured
  const provided = req.headers.get("x-cron-secret");
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on length mismatch — guard first, but still run the
  // compare on equal-length buffers to avoid an early-return timing signal.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
