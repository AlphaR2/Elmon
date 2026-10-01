import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ownRun } from "@/lib/queries";
import { audit } from "@/lib/access";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.res) return g.res;
  const id = Number((await params).id);
  const r = await ownRun(id, g.user);
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (r.created_by !== g.user.id) await audit(g.user.email, "run.stopped", `#${id}`, { owner: r.created_by_email ?? null });
  const db = await getDb();
  await db.run(
    "UPDATE runs SET status = CASE status WHEN 'queued' THEN 'stopped' ELSE 'cancelling' END WHERE id = $1 AND status IN ('queued', 'running')",
    [id],
  );
  return NextResponse.json({ ok: true });
}
