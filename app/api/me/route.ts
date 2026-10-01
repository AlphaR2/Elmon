import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { status } from "@/lib/queries";
import { getAppSettings } from "@/lib/appSettings";

export const dynamic = "force-dynamic";

// The signed-in user plus what the UI needs to warn before a run is wasted.
export async function GET() {
  const g = await guard();
  if (g.res) return g.res;
  const s = await getAppSettings();
  const admin = g.user.role === "admin";
  return NextResponse.json({
    email: g.user.email,
    role: g.user.role,
    ...(await status()),
    paused: s.pauseNewRuns,
    defaultPreset: s.defaultPreset,
    maxBudget: admin ? s.maxBudgetAdmin : s.maxBudgetMember,
    maxLive: admin ? s.maxLiveAdmin : s.maxLiveMember,
  });
}
