import { guard } from "@/lib/auth";
import { listWatch, toCsv } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guard();
  if (g.res) return g.res;
  const format = new URL(req.url).searchParams.get("format");
  const list = await listWatch();
  if (format === "json") {
    return new Response(JSON.stringify(list, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="elmon-watchlist.json"' },
    });
  }
  const rows = list.map((w) => ({
    wallet: w.wallet, label: w.label, note: w.note, added_at: new Date(w.addedAt).toISOString(), added_by: w.addedBy, source_run: w.sourceRun, ...w.snapshot,
  }));
  return new Response(toCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="elmon-watchlist.csv"' },
  });
}
