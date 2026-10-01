import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { ownRun } from "@/lib/queries";
import { requestRunnerRecheck } from "@/lib/pipeline/run";

// Recompute runners and tags from saved histories and free price data. No Helius credits.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.res) return g.res;
  const id = Number((await params).id);
  if (!(await ownRun(id, g.user))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const r = await requestRunnerRecheck(id);
  if (r === "busy") return NextResponse.json({ error: "Wait for the run to finish, then recheck." }, { status: 409 });
  if (r === "missing") return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
