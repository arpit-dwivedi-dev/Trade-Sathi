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

/**
 * Calls a Postgres function and returns its result, typed by the caller.
 *
 * The Supabase client here is not generated from this project's schema, so
 * `.rpc()` is declared as returning `any` — and that `any` then spread into
 * every entitlement and webhook call site, which is exactly where a silently
 * wrong value does the most damage. This is the single place that assertion is
 * made, so each caller states the shape it expects once and works with a real
 * type from there.
 *
 * Throws on a Postgres error, naming the function: callers that want to
 * tolerate a failure (a compensating release, say) catch it, and the ones that
 * must not swallow it get the throw by default.
 */
export async function callRpc<T>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  // The lone `any` this helper exists to absorb: an ungenerated client types
  // rpc results as `any`, and containing it here is the whole point.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) {
    throw new Error(`RPC ${fn} failed: ${error.message}`);
  }
  return data as T;
}
