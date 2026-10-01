import { NextResponse } from "next/server";
import { checkInviteCode, holdInvite, roleFor, tooManyAttempts } from "@/lib/access";
import { supabaseServer } from "@/lib/supabase/server";
import { safeNext } from "@/lib/format";

export const dynamic = "force-dynamic";

// Sends a magic link to admins and members, or to a newcomer with a valid invite code. A code use is NOT
// consumed here: that happens on /auth/callback, once the person has proven they own the email. The answer is
// the same for members and strangers, so the form cannot be used to learn who has access. (A wrong code says so,
// which is only shown to someone who typed a code.)
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { email?: string; code?: string; next?: string } | null;
  const email = b?.email?.trim().toLowerCase() ?? "";
  const code = b?.code?.trim() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  const sb = await supabaseServer();
  if (!sb) return NextResponse.json({ error: "Sign-in is not configured on this deployment." }, { status: 503 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  if (await tooManyAttempts(ip, email)) {
    return NextResponse.json({ error: "Too many attempts. Wait 15 minutes and try again." }, { status: 429 });
  }

  const ok = { ok: true, message: "If you have access, a sign-in link is on its way." };
  const known = (await roleFor(email)) != null;
  if (!known) {
    if (!code) return NextResponse.json(ok); // no access and no code: say nothing, send nothing
    const c = await checkInviteCode(code, email);
    if (!c.ok) return NextResponse.json({ error: "That invite code is not valid, has expired, or has been used up." }, { status: 400 });
    await holdInvite(email, c.id);
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? new URL(req.url).origin;
  const next = safeNext(b?.next);
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${site}/auth/callback?next=${encodeURIComponent(next)}`, shouldCreateUser: true },
  });
  if (error) {
    console.error(JSON.stringify({ level: "warn", msg: "magic link failed", status: error.status, code: error.code }));
    if (error.status === 429) return NextResponse.json({ error: "Too many sign-in emails. Wait a minute and try again." }, { status: 429 });
  }
  return NextResponse.json(ok);
}
