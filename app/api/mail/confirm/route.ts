import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/lib/limits";
import { looksLikeToken } from "@/lib/mail/tokens";
import { store } from "@/lib/mail/service";

// The confirm page's button posts here. Opening the link alone confirms nothing, so a mail
// scanner that opens every link can't sign anyone up.
export async function POST(req: NextRequest) {
  if (!allow(`mail-link:${clientIp(req)}`, 20, 60_000)) return NextResponse.json({ error: "signup_slow" }, { status: 429 });
  const body = await req.json().catch(() => ({}));
  if (!looksLikeToken(body.t)) return NextResponse.json({ error: "link_gone" }, { status: 410 });
  const s = store();
  if (!s) return NextResponse.json({ error: "not_set_up" }, { status: 503 });
  return (await s.confirm(body.t, new Date()))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "link_gone" }, { status: 410 });
}
