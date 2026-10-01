import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { redeemPendingInvite, roleFor } from "@/lib/access";
import { safeNext } from "@/lib/format";

export const dynamic = "force-dynamic";

// The magic link lands here with a one-time code. Exchanging it sets the session cookie and proves the person
// owns the email; only now is an invite code use consumed and the newcomer made a member.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const next = safeNext(u.searchParams.get("next"));
  const sb = await supabaseServer();
  if (!sb || !code) return NextResponse.redirect(new URL("/login?error=link", u.origin));
  const { data, error } = await sb.auth.exchangeCodeForSession(code);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) return NextResponse.redirect(new URL("/login?error=link", u.origin));

  if (!(await roleFor(email, data.user.id))) {
    const r = await redeemPendingInvite(email, data.user.id);
    if (r !== "joined" && r !== "already") {
      await sb.auth.signOut();
      return NextResponse.redirect(new URL(`/login?error=${r === "code-gone" ? "code" : "access"}`, u.origin));
    }
  }
  return NextResponse.redirect(new URL(next, u.origin));
}
