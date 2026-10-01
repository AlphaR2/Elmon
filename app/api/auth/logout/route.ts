import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Sign out. { everywhere: true } also ends every other session of this account (other browsers, phones).
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { everywhere?: boolean } | null;
  const sb = await supabaseServer();
  await sb?.auth.signOut({ scope: b?.everywhere ? "global" : "local" });
  return NextResponse.json({ ok: true });
}
