// Single source of truth for the one allowed account. This app is a personal
// tool — any session whose email doesn't match this is rejected in
// middleware.ts, regardless of how the session was created (password signup,
// Google OAuth, or anything else Supabase Auth might allow in the future).
export const OWNER_EMAIL = "vterminater@gmail.com";
