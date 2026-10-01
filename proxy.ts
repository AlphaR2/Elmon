import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Next 16 proxy (was middleware). Refreshes the Supabase session cookie on every page request and sends
// signed-out visitors to /login. API routes are not redirected: each one checks the session and the allowlist
// itself (lib/auth.ts), which is the real gate. This only makes the pages behave.
export async function proxy(req: NextRequest) {
  if (process.env.ELMON_DEV_NO_AUTH === "1" && process.env.NODE_ENV !== "production") return NextResponse.next();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const path = req.nextUrl.pathname;
  const open = path === "/login" || path.startsWith("/auth/") || path.startsWith("/api/");
  if (!url || !key) {
    return open ? NextResponse.next() : NextResponse.redirect(new URL("/login", req.url));
  }
  let res = NextResponse.next({ request: req });
  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list) res.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await sb.auth.getClaims();
  if (!data?.claims && !open) {
    const to = new URL("/login", req.url);
    if (path !== "/") to.searchParams.set("next", path);
    return NextResponse.redirect(to);
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
