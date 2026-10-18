import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { SHELF } from "@/lib/catalog";
import { formatUsdc } from "@/lib/engine/money";
import { openState, step, type State } from "@/lib/engine/negotiate";
import { signOffer } from "@/lib/offer";
import { seal, unseal } from "@/lib/seal";
import { displayText, readIntent, speak, type Turn } from "@/lib/shopkeeper";

interface Session {
  item: string;
  state: State;
  history: Turn[];
  exp: number;
}

const SESSION_TTL = 60 * 60;
const OFFER_TTL = 5 * 60;

function opening(name: string, list: number): string {
  return `[sarcastic] Ah, a customer. "${name}". ${formatUsdc(list)} USDC, and before you ask, no, there's no price tag.`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const now = Math.floor(Date.now() / 1000);

  // New haggle
  if (!body.session) {
    const item = SHELF[String(body.item ?? "")];
    if (!item) return NextResponse.json({ error: "no_such_item" }, { status: 404 });
    const line = opening(item.name, item.list);
    const session: Session = { item: item.id, state: openState(item), history: [{ who: "keeper", text: displayText(line) }], exp: now + SESSION_TTL };
    return NextResponse.json({
      line: displayText(line),
      voice: seal("line", line),
      action: "open",
      ask: session.state.ask,
      session: seal("session", session),
    });
  }

  const session = unseal<Session>("session", body.session);
  if (!session || session.exp < now) return NextResponse.json({ error: "session_expired" }, { status: 410 });
  const item = SHELF[session.item];
  const message = String(body.message ?? "").slice(0, 600).trim();
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });

  const intent = await readIntent(item, session.state.ask, session.history, message).catch((e) => {
    console.error("readIntent failed, treating as chat:", (e as Error).message);
    return { kind: "chat", tone: "neutral" } as const;
  });
  const { state, decision } = step(item, session.state, intent);
  const line = await speak(item, decision, intent, session.history, message);

  const history: Turn[] = [...session.history, { who: "buyer" as const, text: message }, { who: "keeper" as const, text: displayText(line) }].slice(-12);
  const next: Session = { ...session, state, history };

  const offer =
    decision.deal && (decision.action === "deal" || decision.action === "pledge_deal")
      ? signOffer({ v: 1, item: item.id, deal: decision.deal, exp: now + OFFER_TTL, nonce: randomUUID() })
      : undefined;

  return NextResponse.json({
    line: displayText(line),
    voice: seal("line", line),
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
