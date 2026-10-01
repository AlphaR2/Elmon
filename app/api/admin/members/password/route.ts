import { NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth";
import { audit, cutOffSessions, isAdminEmail, memberRecord, normEmail, setMustChangePassword, tempPassword } from "@/lib/access";
import { findUserIdByEmail, supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Reset a member's password to a temporary one, shown to the admin once. The member is asked to choose their own
// on next sign-in. Admins change their own password on the Account page.
export async function POST(req: Request) {
  const g = await adminGuard();
  if (g.res) return g.res;
  const b = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = b?.email ? normEmail(b.email) : "";
  if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });
  if (isAdminEmail(email)) return NextResponse.json({ error: "Admins change their own password on the Account page." }, { status: 400 });
  const m = await memberRecord(email);
  if (!m) return NextResponse.json({ error: "Not a member" }, { status: 404 });
  const admin = supabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Password resets need SUPABASE_SERVICE_ROLE_KEY on the server." }, { status: 503 });
  const userId = m.user_id ?? (await findUserIdByEmail(email));
  if (!userId) return NextResponse.json({ error: "This member has no sign-in account yet." }, { status: 404 });
  const password = tempPassword();
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) return NextResponse.json({ error: "Could not reset the password. Try again." }, { status: 500 });
  await setMustChangePassword(email, true);
  await cutOffSessions(email); // anyone still signed in as them is signed out
  await audit(g.user.email, "member.password_reset", email);
  return NextResponse.json({ ok: true, password });
}
