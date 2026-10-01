import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { classifyAddresses } from "@/lib/classify";
import { isAddress } from "@/lib/format";

export const dynamic = "force-dynamic";

// Token or wallet? Checked while you paste, so a batch of wallets is not run as tokens (or the reverse).
// Uses free public sources only; never Helius.
export async function POST(req: Request) {
  const g = await guard();
  if (g.res) return g.res;
  const b = (await req.json().catch(() => null)) as { addresses?: unknown } | null;
  const list = Array.isArray(b?.addresses) ? b.addresses.filter((a): a is string => typeof a === "string" && isAddress(a)) : [];
  if (list.length === 0) return NextResponse.json({});
  if (list.length > 200) return NextResponse.json({ error: "At most 200 addresses" }, { status: 400 });
  return NextResponse.json(await classifyAddresses(list));
}
