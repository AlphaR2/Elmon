import { NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth";
import { adminOverview } from "@/lib/adminData";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await adminGuard();
  if (g.res) return g.res;
  return NextResponse.json(await adminOverview());
}
