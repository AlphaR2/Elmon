import { NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth";
import { isAdminEmail, removeMember } from "@/lib/access";

export const dynamic = "force-dynamic";

// Remove a member. They are locked out on their next request, even if still signed in.
export async function DELETE(req: Request) {
  const g = await adminGuard();
  if (g.res) return g.res;
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });
  if (isAdminEmail(email)) return NextResponse.json({ error: "Admins are set in ELMON_ADMIN_EMAILS and cannot be removed here." }, { status: 400 });
  return (await removeMember(g.user.email, email)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not a member" }, { status: 404 });
}
