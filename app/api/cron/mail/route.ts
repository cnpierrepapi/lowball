import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { drain } from "@/lib/mail/outbox";
import { dailyCap, mailer } from "@/lib/mail/mailer";
import { store } from "@/lib/mail/service";

// Once a day, Vercel calls this to send whatever didn't fit under yesterday's cap.
// Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else is turned away.

export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const s = store();
  if (!s) return NextResponse.json({ error: "not_set_up" }, { status: 503 });
  const result = await drain(s, mailer(), { cap: dailyCap(), budgetMs: 45_000 });
  return NextResponse.json(result);
}
