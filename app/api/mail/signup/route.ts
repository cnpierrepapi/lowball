import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/lib/limits";
import { checkEmail } from "@/lib/mail/address";
import { sendSoon, store } from "@/lib/mail/service";

// Sign up for drop emails. The answer is the same whether the address is new, already on the
// list, or already confirmed, so nobody can use this to find out who's signed up.

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (!allow(`signup:${ip}`, 5, 60_000) || !allow(`signup-h:${ip}`, 20, 3_600_000)) {
    return NextResponse.json({ error: "signup_slow" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const body = await req.json().catch(() => ({}));
  const email = await checkEmail(body.email);
  if (!email) return NextResponse.json({ error: "bad_email" }, { status: 400 });
  const s = store();
  if (!s) return NextResponse.json({ error: "not_set_up" }, { status: 503 });
  try {
    await s.signup(email, new Date());
    await sendSoon(s);
  } catch (e) {
    console.error("signup:", (e as Error).message);
    return NextResponse.json({ error: "generic" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
