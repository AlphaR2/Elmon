import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { passwordProblem, setMustChangePassword } from "@/lib/access";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Change your own password. The current one is checked first, so a session left open on a shared computer is not
// enough to take over the account.
export async function POST(req: Request) {
  const g = await guard();
  if (g.res) return g.res;
  const b = (await req.json().catch(() => null)) as { current?: string; next?: string } | null;
  const weak = passwordProblem(b?.next ?? "");
  if (weak) return NextResponse.json({ error: weak }, { status: 400 });
  if (b?.next === b?.current) return NextResponse.json({ error: "Choose a password different from the current one." }, { status: 400 });
  const sb = await supabaseServer();
  if (!sb) return NextResponse.json({ error: "Sign-in is not configured on this deployment." }, { status: 503 });
  const check = await sb.auth.signInWithPassword({ email: g.user.email, password: b?.current ?? "" });
  if (check.error) return NextResponse.json({ error: "Your current password is not right." }, { status: 400 });
  const { error } = await sb.auth.updateUser({ password: b!.next! });
  if (error) return NextResponse.json({ error: error.message || "Could not change the password." }, { status: 400 });
  await setMustChangePassword(g.user.email, false);
  return NextResponse.json({ ok: true });
}
