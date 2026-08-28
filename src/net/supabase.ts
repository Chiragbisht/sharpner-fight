import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

// The one Supabase client for the app. Nothing in src/game/ may import this —
// the sim has to stay pure for determinism. See tools/verify.mts.

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const isConfigured: boolean = Boolean(url && key);

// Typed as non-null even though it is null without keys. Every caller is behind
// an `isConfigured` check or a sign-in gate, and threading `| null` through
// forty call sites would mean a non-null assertion at each one instead of here.
export const supabase: SupabaseClient =
  url && key
    ? createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // We never come back from a redirect — sign-in happens in a Google
          // popup on our own origin — so there is no token in the URL to parse.
          detectSessionInUrl: false,
        },
      })
    : (null as unknown as SupabaseClient);
