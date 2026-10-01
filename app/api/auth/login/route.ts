import { NextResponse } from "next/server";
import { memberRecord, roleFor, tooManyAttempts } from "@/lib/access";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Email + password sign-in. A wrong email and a wrong password get the same answer. An account that is no longer
// a member (removed by an admin) is signed straight out again.
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { email?: string; password?: string } | null;
  const email = b?.email?.trim().toLowerCase() ?? "";
  const password = b?.password ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  const sb = await supabaseServer();
  if (!sb) return NextResponse.json({ error: "Sign-in is not configured on this deployment." }, { status: 503 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  if (await tooManyAttempts(ip, email)) return NextResponse.json({ error: "Too many attempts. Wait 15 minutes and try again." }, { status: 429 });

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.user) return NextResponse.json({ error: "Wrong email or password." }, { status: 400 });

  const role = await roleFor(email, data.user.id);
  if (!role) {
    await sb.auth.signOut();
    return NextResponse.json({ error: "This account does not have access. Ask your admin for an invite code." }, { status: 403 });
  }
  const m = role === "member" ? await memberRecord(email) : undefined;
  return NextResponse.json({ ok: true, mustChangePassword: !!m?.must_change_password });
}
