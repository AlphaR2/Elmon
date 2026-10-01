import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { walletDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; wallet: string }> }) {
  const g = await guard();
  if (g.res) return g.res;
  const p = await params;
  const d = await walletDetail(Number(p.id), p.wallet, g.user);
  return d ? NextResponse.json(d) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
