import { guard } from "@/lib/auth";
import { exportRows, markExported, ownRun, toCsv, type ExportKind } from "@/lib/queries";

export const dynamic = "force-dynamic";

const KINDS: ExportKind[] = ["traders", "starred", "insiders", "buyers"];

// Exporting starts the results' 24 h countdown (see markExported). The chain cache is not affected.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.res) return g.res;
  const id = Number((await params).id);
  if (!(await ownRun(id, g.user))) return Response.json({ error: "Not found" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const kind = KINDS.find((k) => k === q.get("kind")) ?? "traders";
  const format = q.get("format") === "json" ? "json" : "csv";
  const rows = await exportRows(id, kind, g.user);
  await markExported(id);
  const name = `elmon-run${id}-${kind}.${format}`;
  if (format === "json") {
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"` },
    });
  }
  return new Response(toCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
}
