import { NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth";
import { createInviteCode, revokeInviteCode } from "@/lib/access";

export const dynamic = "force-dynamic";

// Create an invite code. The code is returned once and never stored in readable form.
export async function POST(req: Request) {
  const g = await adminGuard();
  if (g.res) return g.res;
  const b = (await req.json().catch(() => null)) as { maxUses?: number; expiresInDays?: number | null; label?: string; boundEmail?: string } | null;
  try {
    const r = await createInviteCode(g.user.email, {
      maxUses: Number(b?.maxUses ?? 5),
      expiresInDays: b?.expiresInDays == null ? null : Number(b.expiresInDays),
      label: b?.label?.trim() || null,
      boundEmail: b?.boundEmail?.trim() || null,
    });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const g = await adminGuard();
  if (g.res) return g.res;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isSafeInteger(id)) return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  return (await revokeInviteCode(g.user.email, id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found or already revoked" }, { status: 404 });
}
