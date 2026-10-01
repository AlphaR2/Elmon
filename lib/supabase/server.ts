import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Browser-safe Supabase settings: the project URL and the publishable (anon) key. Row level security keeps that
// key away from every table; it is only used for sign-in.
export function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

// Server Components and route handlers. Cookie writes fail in Server Components; the proxy refreshes them.
export async function supabaseServer() {
  const env = supabaseEnv();
  if (!env) return null;
  const store = await cookies();
  return createServerClient(env.url, env.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // called from a Server Component: the proxy has already refreshed the session
        }
      },
    },
  });
}
