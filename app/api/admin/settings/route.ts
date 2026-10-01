import { NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth";
import { getAppSettings, parseAppSettings, saveAppSettings, type AppSettings } from "@/lib/appSettings";
import { audit } from "@/lib/access";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// Change limits without a deploy. `monthlyCredits` (null = use HELIUS_MONTHLY_CREDITS) is stored separately.
export async function PUT(req: Request) {
  const g = await adminGuard();
  if (g.res) return g.res;
  const b = (await req.json().catch(() => null)) as (Partial<AppSettings> & { monthlyCredits?: number | null }) | null;
  if (!b) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const before = await getAppSettings();
  let next: AppSettings;
  try {
    const { monthlyCredits: _m, ...rest } = b;
    void _m;
    next = parseAppSettings(rest, before);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const db = await getDb();
  if ("monthlyCredits" in b) {
    const mc = b.monthlyCredits;
    if (mc != null && (!Number.isFinite(Number(mc)) || Number(mc) < 1000 || Number(mc) > 1e10)) {
      return NextResponse.json({ error: "Monthly credits must be at least 1,000, or empty to use the environment value" }, { status: 400 });
    }
    await db.run(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('monthly_credits', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify(mc == null ? null : Math.round(Number(mc))), Date.now()],
    );
  }
  await saveAppSettings(next, db);
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => before[k as keyof AppSettings] !== v));
  if ("monthlyCredits" in b) changed.monthlyCredits = b.monthlyCredits ?? null;
  if (Object.keys(changed).length) await audit(g.user.email, "settings.changed", null, changed, db);
  return NextResponse.json({ ok: true, settings: next });
}
