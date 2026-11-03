import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

// Vercel calls the daily jobs with "Authorization: Bearer <CRON_SECRET>". Anything else, or a
// missing or short secret, is turned away.
export function cronAuthorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
