import { NextRequest, NextResponse } from "next/server";
import { drain } from "@/lib/mail/outbox";
import { dailyCap } from "@/lib/mail/mailer";
import { activeMailer, store } from "@/lib/mail/service";
import { cronAuthorised } from "@/lib/cron";

// Once a day, Vercel calls this to send whatever didn't fit under yesterday's cap.

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!cronAuthorised(req)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const s = store();
  if (!s) return NextResponse.json({ error: "not_set_up" }, { status: 503 });
  const result = await drain(s, await activeMailer(), { cap: dailyCap(), budgetMs: 45_000 });
  return NextResponse.json(result);
}
