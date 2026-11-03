import { NextRequest, NextResponse } from "next/server";
import { cronAuthorised } from "@/lib/cron";
import { daily } from "@/lib/research/loop";
import { liveDeps } from "@/lib/research/service";

// Once a day: watch the sources, then at most one investigation and one pack, best lead first.
// Investigating can take minutes (web searches), so this route may run up to 5 minutes.

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const deps = await liveDeps();
  if (!deps) return NextResponse.json({ error: "not_set_up" }, { status: 503 });
  try {
    return NextResponse.json(await daily(deps));
  } catch (e) {
    console.error("research cron:", (e as Error).message);
    return NextResponse.json({ error: "generic" }, { status: 500 });
  }
}
