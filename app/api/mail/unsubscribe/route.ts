import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/lib/limits";
import { looksLikeToken } from "@/lib/mail/tokens";
import { store } from "@/lib/mail/service";

// Deletes the subscriber. Two ways in: the unsubscribe page's button (JSON body), and the
// one-click unsubscribe mail apps offer (RFC 8058: a POST to the link in the email header,
// with the token in the address).
export async function POST(req: NextRequest) {
  if (!allow(`mail-link:${clientIp(req)}`, 20, 60_000)) return NextResponse.json({ error: "signup_slow" }, { status: 429 });
  const body = await req.json().catch(() => ({}));
  const t = req.nextUrl.searchParams.get("t") ?? body.t;
  if (!looksLikeToken(t)) return NextResponse.json({ error: "link_gone" }, { status: 410 });
  const s = store();
  if (!s) return NextResponse.json({ error: "not_set_up" }, { status: 503 });
  return (await s.unsubscribe(t)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "link_gone" }, { status: 410 });
}
