import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { ownRun } from "@/lib/queries";
import { requestInsiderScan } from "@/lib/pipeline/run";
import { isAddress } from "@/lib/format";

// Trace the funders of every early buyer of one launch (insiders, bundles). Only buyers not traced before cost.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.res) return g.res;
  const id = Number((await params).id);
  if (!(await ownRun(id, g.user))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = (await req.json().catch(() => null)) as { mint?: string } | null;
  if (!b?.mint || !isAddress(b.mint)) return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  const r = await requestInsiderScan(id, b.mint);
  if (r === "busy") return NextResponse.json({ error: "Wait for the run to finish, then scan." }, { status: 409 });
  if (r === "unknown-mint") return NextResponse.json({ error: "That token is not in this run" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
