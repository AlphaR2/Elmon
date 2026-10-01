import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST() {
  const sb = await supabaseServer();
  await sb?.auth.signOut();
  return NextResponse.json({ ok: true });
}
