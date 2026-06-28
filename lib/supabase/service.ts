import { createClient } from "@supabase/supabase-js";

// Service role client — bypasses RLS. Only for server-side API routes.
// Never expose this key to the browser.
let _client: ReturnType<typeof createClient> | null = null;

export function createServiceClient() {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _client;
}
