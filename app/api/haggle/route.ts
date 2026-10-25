import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { SHELF } from "@/lib/catalog";
import { formatUsdc } from "@/lib/engine/money";
import { openState, step, type State } from "@/lib/engine/negotiate";
import { signOffer } from "@/lib/offer";
import { seal, unseal } from "@/lib/seal";
import { displayText, readIntent, speak, type Turn } from "@/lib/shopkeeper";
import { allow, clientIp } from "@/lib/limits";
import { VertexConfigError } from "@/lib/vertex";
import { voiceToken } from "@/lib/voice";
import { ConfigError } from "@/lib/config";

interface Session {
  item: string;
  state: State;
  history: Turn[];
  exp: number;
  ref?: string; // came in through a pledger's link
  turns?: number; // every message counts, chat included
}

const SESSION_TTL = 60 * 60;
const OFFER_TTL = 5 * 60;
// How long a pledger's friends have to buy. Short in the demo so a refund can be shown live.
const PLEDGE_WINDOW = Number(process.env.PLEDGE_WINDOW_SECONDS ?? 7 * 24 * 60 * 60);
// Each turn is two model calls. Chat used to be free and endless; now every message counts.
const MAX_TURNS = Number(process.env.HAGGLE_MAX_TURNS ?? 40);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function opening(name: string, list: number): string {
  return `[sarcastic] Ah, a customer. "${name}". ${formatUsdc(list)} USDC, and before you ask, no, there's no price tag.`;
}

const unavailable = () =>
  NextResponse.json({ error: "shopkeeper_unavailable" }, { status: 503 });

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (!allow(`haggle:${ip}`, 20, 60_000) || !allow(`haggle-h:${ip}`, 200, 3_600_000)) {
    return NextResponse.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "30" } });
  }
  try {
    return await haggle(req);
  } catch (e) {
    // Missing or refused credentials: fail loudly instead of a shop that never deals.
    if (e instanceof VertexConfigError) {
      console.error("haggle: vertex config:", e.message);
      return unavailable();
    }
    console.error("haggle:", (e as Error).message);
    // Always JSON, so the page can say what happened.
    return NextResponse.json({ error: e instanceof ConfigError ? "not_set_up" : "generic" }, { status: e instanceof ConfigError ? 503 : 500 });
  }
}

async function haggle(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const now = Math.floor(Date.now() / 1000);

  // New haggle
  if (!body.session) {
    const item = SHELF[String(body.item ?? "")];
    if (!item) return NextResponse.json({ error: "no_such_item" }, { status: 404 });
    const line = opening(item.name, item.list);
    const ref = typeof body.ref === "string" && UUID.test(body.ref) ? body.ref : undefined;
    const session: Session = { item: item.id, state: openState(item), history: [{ who: "keeper", text: displayText(line) }], exp: now + SESSION_TTL, ref };
    return NextResponse.json({
      line: displayText(line),
      voice: voiceToken(line, now),
      action: "open",
      ask: session.state.ask,
      // Public details only. The floor never leaves the server.
      item: { id: item.id, name: item.name, blurb: item.blurb, list: item.list },
      session: seal("session", session),
    });
  }

  const session = unseal<Session>("session", body.session);
  if (!session || session.exp < now) return NextResponse.json({ error: "session_expired" }, { status: 410 });
  const item = SHELF[session.item];
  const message = String(body.message ?? "").slice(0, 600).trim();
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });
  const turns = (session.turns ?? 0) + 1;
  if (turns > MAX_TURNS) return NextResponse.json({ error: "shop_closed", line: "We're closing. Come back tomorrow." }, { status: 429 });

  const intent = await readIntent(item, session.state.ask, session.history, message).catch((e) => {
    if (e instanceof VertexConfigError) throw e;
    console.error("readIntent failed, treating as chat:", (e as Error).message);
    return { kind: "chat", tone: "neutral" } as const;
  });
  const { state, decision } = step(item, session.state, intent);
  const line = await speak(item, decision, intent, session.history, message);

  const history: Turn[] = [...session.history, { who: "buyer" as const, text: message }, { who: "keeper" as const, text: displayText(line) }].slice(-12);
  const next: Session = { ...session, state, history, turns };

  const offer =
    decision.deal && (decision.action === "deal" || decision.action === "pledge_deal")
      ? signOffer({
          v: 1, item: item.id, deal: decision.deal, exp: now + OFFER_TTL, nonce: randomUUID(),
          ...(decision.deal.kind === "pledge" ? { deadline: now + PLEDGE_WINDOW } : { ref: session.ref }),
        })
      : undefined;

  return NextResponse.json({
    line: displayText(line),
    voice: voiceToken(line, now),
    action: decision.action,
    ask: decision.ask,
    mood: decision.mood,
    referralsNeeded: decision.referralsNeeded,
    deal: decision.deal,
    offer,
    offerExpiresAt: offer ? now + OFFER_TTL : undefined,
    intent,
    session: seal("session", next),
  });
}
