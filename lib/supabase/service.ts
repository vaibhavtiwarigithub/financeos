import { createClient } from "@supabase/supabase-js";

// Service role client — bypasses RLS. Only for server-side API routes.
// Never expose this key to the browser.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;

// Returns any — we don't use generated schema types; tables are added iteratively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createServiceClient(): any {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _client;
}
