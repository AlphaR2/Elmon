import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Supabase admin client: creates accounts (already confirmed, so no confirmation email is ever sent) and resets
// passwords. Uses SUPABASE_SERVICE_ROLE_KEY, which must only ever be set on the server (Vercel), never exposed to
// the browser: it bypasses row level security. Returns null when it is not configured, and callers fail closed.

let cached: SupabaseClient | null | undefined;

export function supabaseAdmin(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  cached = url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
  return cached;
}

// Tests swap the client in.
export function _setSupabaseAdminForTests(c: SupabaseClient | null | undefined) {
  cached = c;
}

// The auth user id for an email (for members who joined before user ids were recorded). Pages through users.
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const admin = supabaseAdmin();
  if (!admin) return null;
  const e = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const hit = data.users.find((u) => u.email?.toLowerCase() === e);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}
