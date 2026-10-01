import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { deleteRun, ownRun, runDetail } from "@/lib/queries";
import { audit } from "@/lib/access";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.res) return g.res;
  const d = await runDetail(Number((await params).id), g.user);
  return d ? NextResponse.json(d) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.res) return g.res;
  const id = Number((await params).id);
  const r = await ownRun(id, g.user);
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (r.status === "running" || r.status === "cancelling") return NextResponse.json({ error: "Stop the run first" }, { status: 409 });
  if (r.created_by !== g.user.id) await audit(g.user.email, "run.cleared", `#${id}`, { owner: r.created_by_email ?? null });
  await deleteRun(id);
  return NextResponse.json({ ok: true });
}
