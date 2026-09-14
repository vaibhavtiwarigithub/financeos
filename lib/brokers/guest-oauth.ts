// Shared constants for the guest broker OAuth flow.
//
// This lives in `lib/` rather than in the login route because a Next.js
// `route.ts` may only export HTTP method handlers and a fixed set of config
// fields — any other export fails `next build` with "is not a valid Route
// export field", even though `tsc` accepts it. Exporting it from the route was
// exactly that mistake, caught by Vercel rather than locally;
// `tests/route-module-exports.test.ts` now catches it here.
//
// The login route writes `guest:<userId>` into the HMAC-signed state cookie and
// the shared Kite callback reads it back to decide whose token it just
// exchanged. Both sides must agree on the prefix, so it has exactly one home.

/** Marks a login started by a guest, and for whom. Verified, never trusted raw. */
export const GUEST_VERIFIER_PREFIX = "guest:";
