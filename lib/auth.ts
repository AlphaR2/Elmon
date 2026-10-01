import "server-only"; // build fails if a page ever imports this
import { NextResponse } from "next/server";
import { roleFor, type Role } from "./access";
import { supabaseEnv, supabaseServer } from "./supabase/server";

// Who may use Elmon: a signed-in Supabase user who is an admin (ELMON_ADMIN_EMAILS) or a member (joined with an
// invite code). Checked on every API request, so removing a member locks them out at once, even with a valid
// session. Fails closed: with sign-in not configured every request is refused, except in local development with
// ELMON_DEV_NO_AUTH=1 (refused in production).

export interface User {
  id: string;
  email: string;
  role: Role;
}

export const devBypass = () => process.env.ELMON_DEV_NO_AUTH === "1" && process.env.NODE_ENV !== "production";
const DEV_USER: User = { id: "dev", email: "dev@localhost", role: "admin" };

export async function currentUser(): Promise<User | null> {
  if (devBypass()) return DEV_USER;
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub || typeof claims.email !== "string") return null;
  const role = await roleFor(claims.email, claims.sub, typeof claims.iat === "number" ? claims.iat : null);
  if (!role) return null;
  return { id: claims.sub, email: claims.email.toLowerCase(), role };
}

type Guarded = { user: User; res?: undefined } | { user?: undefined; res: NextResponse };

// Route handlers: `const g = await guard(); if (g.res) return g.res;`
export async function guard(): Promise<Guarded> {
  if (!devBypass() && !supabaseEnv()) {
    return { res: NextResponse.json({ error: "Sign-in is not configured on this deployment." }, { status: 503 }) };
  }
  try {
    const user = await currentUser();
    if (!user) return { res: NextResponse.json({ error: "Sign in to continue." }, { status: 401 }) };
    return { user };
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "auth check failed", err: String((e as Error).message ?? e) }));
    return { res: NextResponse.json({ error: "Could not check your session. Try again." }, { status: 503 }) };
  }
}

// Admin-only routes answer "not found" to everyone else, so they do not even reveal that they exist.
export async function adminGuard(): Promise<Guarded> {
  const g = await guard();
  if (g.res) return g.res.status === 401 ? { res: NextResponse.json({ error: "Not found" }, { status: 404 }) } : g;
  if (g.user.role !== "admin") return { res: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  return g;
}
