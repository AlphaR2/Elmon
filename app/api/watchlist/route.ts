import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { addWatch, listWatch, removeWatch, updateWatch } from "@/lib/queries";
import { isAddress } from "@/lib/format";

export const dynamic = "force-dynamic";

// The watchlist is shared by the team.
export async function GET() {
  const g = await guard();
  if (g.res) return g.res;
  return NextResponse.json(await listWatch());
}

export async function POST(req: Request) {
  const g = await guard();
  if (g.res) return g.res;
  const b = (await req.json().catch(() => null)) as { wallet?: string; sourceRun?: number; label?: string } | null;
  if (!b?.wallet || !isAddress(b.wallet)) return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  await addWatch(b.wallet, typeof b.sourceRun === "number" ? b.sourceRun : null, b.label?.slice(0, 60) ?? null, g.user);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const g = await guard();
  if (g.res) return g.res;
  const b = (await req.json().catch(() => null)) as { wallet?: string; label?: string | null; note?: string | null } | null;
  if (!b?.wallet || !isAddress(b.wallet)) return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  await updateWatch(b.wallet, { label: b.label?.slice(0, 60), note: b.note?.slice(0, 500) });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const g = await guard();
  if (g.res) return g.res;
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet || !isAddress(wallet)) return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  await removeWatch(wallet);
  return NextResponse.json({ ok: true });
}
