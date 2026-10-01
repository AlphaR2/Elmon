import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { createRun, RunLimitError } from "@/lib/pipeline/run";
import { getAppSettings } from "@/lib/appSettings";
import { listRuns, status } from "@/lib/queries";
import { parseAddresses } from "@/lib/format";
import { estimateCredits, parseSettings } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard();
  if (g.res) return g.res;
  return NextResponse.json(await listRuns(g.user.id));
}

// Starting a run is where credits are protected before any are spent: bad input, a batch that cannot overlap,
// or a month without enough left is refused here; an identical live run is returned instead of a second one.
export async function POST(req: Request) {
  const g = await guard();
  if (g.res) return g.res;
  const body = (await req.json().catch(() => null)) as { mode?: string; inputs?: string | string[]; settings?: unknown; label?: string } | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const mode = body.mode === "wallets" ? "wallets" : "tokens";
  const text = Array.isArray(body.inputs) ? body.inputs.join("\n") : body.inputs ?? "";
  const { valid, invalid } = parseAddresses(text);
  if (invalid.length) return NextResponse.json({ error: `Not Solana addresses: ${invalid.slice(0, 5).join(", ")}` }, { status: 400 });
  if (valid.length === 0) return NextResponse.json({ error: "Paste at least one address" }, { status: 400 });
  if (valid.length > 200) return NextResponse.json({ error: "At most 200 addresses per run" }, { status: 400 });
  let settings;
  try {
    settings = parseSettings(body.settings);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const min = Math.max(2, settings.minHits);
  if (mode === "tokens" && valid.length < min) {
    return NextResponse.json({ error: `Paste at least ${min} tokens: wallets are found by being early in several of them.` }, { status: 400 });
  }
  // Limits by role, from the admin settings.
  const app = await getAppSettings();
  const admin = g.user.role === "admin";
  if (app.pauseNewRuns && !admin) {
    return NextResponse.json({ error: "New runs are paused by an admin right now. Try again later." }, { status: 503 });
  }
  const maxBudget = admin ? app.maxBudgetAdmin : app.maxBudgetMember;
  if (settings.runBudget > maxBudget) {
    return NextResponse.json({ error: `The run budget can be at most ${maxBudget.toLocaleString()} credits for your account.` }, { status: 400 });
  }
  const est = estimateCredits(mode, valid.length, settings);
  const st = await status();
  if (st.creditsLeft < est.low) {
    return NextResponse.json(
      { error: `Not enough credits left this month (${st.creditsLeft.toLocaleString()} left, this needs at least ${est.low.toLocaleString()}).` },
      { status: 400 },
    );
  }
  try {
    const { id, existing } = await createRun(mode, valid, settings, {
      label: body.label?.slice(0, 80) || undefined,
      userId: g.user.id,
      userEmail: g.user.email,
      maxLive: admin ? app.maxLiveAdmin : app.maxLiveMember,
      priority: admin ? 1 : 0,
      ttlMs: app.resultTtlDays * 86_400_000,
    });
    return NextResponse.json({ id, existing });
  } catch (e) {
    if (e instanceof RunLimitError) return NextResponse.json({ error: e.message }, { status: 429 });
    throw e;
  }
}
