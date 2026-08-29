import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

// Both clients run in a stateless server process: never persist or refresh a session,
// and never try to read one out of a URL.
const serverClientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
} as const;

/**
 * Privileged client — uses the service role key and bypasses RLS.
 * Use for all backend-owned work: quota RPCs, storage uploads, writes to
 * analyses/usage_counters.
 */
export const supabaseAdmin = createClient(
  env.supabaseUrl,
  env.supabaseServiceRoleKey,
  serverClientOptions,
);

/**
 * Anon-key client — used ONLY to verify incoming user JWTs via getClaims().
 * Never use it for data operations.
 */
export const supabaseAuth = createClient(
  env.supabaseUrl,
  env.supabaseAnonKey,
  serverClientOptions,
);
