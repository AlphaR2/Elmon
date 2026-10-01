import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ownRun } from "@/lib/queries";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.res) return g.res;
  const id = Number((await params).id);
  if (!(await ownRun(id, g.user))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const db = await getDb();
  await db.run("UPDATE runs SET status = 'queued', error = NULL, finished_at = NULL WHERE id = $1 AND status IN ('stopped', 'failed')", [id]);
  return NextResponse.json({ ok: true });
}
