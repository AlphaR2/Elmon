import { NextResponse } from "next/server";
import { adminSetupCodeOk, checkInviteCode, isAdminEmail, passwordProblem, redeemCodeNow, roleFor, tooManyAttempts } from "@/lib/access";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// First-time sign-up: email + password + invite code. Admins (ELMON_ADMIN_EMAILS) use the admin setup code
// (ELMON_ADMIN_SETUP_CODE) in the same field, so nobody can claim an admin email before its owner does. The account is
// created already confirmed, so no email is ever sent. The code use and the membership are recorded in one
// transaction; if the last use went to someone else in the meantime, the new account is removed again.
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { email?: string; password?: string; code?: string } | null;
  const email = b?.email?.trim().toLowerCase() ?? "";
  const password = b?.password ?? "";
  if (!EMAIL.test(email) || email.length > 200) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  const weak = passwordProblem(password);
  if (weak) return NextResponse.json({ error: weak }, { status: 400 });

  const admin = supabaseAdmin();
  const sb = await supabaseServer();
  if (!admin || !sb) return NextResponse.json({ error: "Sign-up is not configured on this deployment." }, { status: 503 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  if (await tooManyAttempts(ip, email)) return NextResponse.json({ error: "Too many attempts. Wait 15 minutes and try again." }, { status: 429 });

  const isAdmin = isAdminEmail(email);
  if (!isAdmin && (await roleFor(email))) return NextResponse.json({ error: "You already have access. Sign in instead." }, { status: 400 });
  if (isAdmin && !adminSetupCodeOk(b?.code)) {
    return NextResponse.json({ error: "That invite code is not valid, has expired, or has been used up." }, { status: 400 });
  }

  let codeId: number | null = null;
  if (!isAdmin) {
    const c = await checkInviteCode(b?.code ?? "", email);
    if (!c.ok) return NextResponse.json({ error: "That invite code is not valid, has expired, or has been used up." }, { status: 400 });
    codeId = c.id;
  }

  // Create the account, or (someone returning with a new code) prove they own the existing one.
  let userId: string;
  let createdNow = false;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    const exists = created.error?.code === "email_exists" || /already|registered|exists/i.test(created.error?.message ?? "");
    if (!exists) {
      console.error(JSON.stringify({ level: "error", msg: "createUser failed", code: created.error?.code, status: created.error?.status }));
      return NextResponse.json({ error: "Could not create the account. Try again." }, { status: 500 });
    }
    const s = await sb.auth.signInWithPassword({ email, password });
    if (s.error || !s.data.user) {
      return NextResponse.json({ error: "An account with this email already exists. Use its password, or ask your admin to reset it." }, { status: 400 });
    }
    userId = s.data.user.id;
  } else {
    userId = created.data.user.id;
    createdNow = true;
  }

  if (codeId != null && !(await redeemCodeNow(codeId, email, userId))) {
    if (createdNow) await admin.auth.admin.deleteUser(userId);
    await sb.auth.signOut();
    return NextResponse.json({ error: "That invite code was just used up. Ask your admin for a new one." }, { status: 400 });
  }

  if (createdNow) {
    const s = await sb.auth.signInWithPassword({ email, password });
    if (s.error) return NextResponse.json({ ok: true, signIn: true, message: "Account created. Sign in with your new password." });
  }
  return NextResponse.json({ ok: true });
}
