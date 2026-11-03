import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { formatUsdc } from "@/lib/engine/money";
import { openState, step } from "@/lib/engine/negotiate";
import { liftAsk } from "@/lib/engine/drops";
import { holdCopy, onSale, type OnSale } from "@/lib/shop/service";
import { formatOpensAt } from "@/lib/mail/templates";
import { copy } from "@/lib/copy";
import { signOffer } from "@/lib/offer";
import { seal, unseal } from "@/lib/seal";
import { displayText, readIntent, speak, type Turn } from "@/lib/shopkeeper";
import { allow, clientIp } from "@/lib/limits";
import { ModelConfigError } from "@/lib/claude";
import { ConfigError } from "@/lib/config";
import { gameToOffer, offerGame } from "@/lib/engine/games";
import { gameStore } from "@/lib/games/store";
import { newSeed } from "@/lib/games/play";
import type { Session } from "@/lib/session";


const SESSION_TTL = 60 * 60;
const OFFER_TTL = 5 * 60;
// How long a pledger's friends have to buy. Short in the demo so a refund can be shown live.
const PLEDGE_WINDOW = Number(process.env.PLEDGE_WINDOW_SECONDS ?? 7 * 24 * 60 * 60);
// Each turn is two model calls. Chat used to be free and endless; now every message counts.
const MAX_TURNS = Number(process.env.HAGGLE_MAX_TURNS ?? 40);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function opening(name: string, list: number): string {
  return `Ah, a customer. "${name}". ${formatUsdc(list)} USDC, and before you ask, no, there's no price tag.`;
}

// A drop that isn't open answers with her line and no haggle: no model calls, no offer.
function notOnSale(sale: OnSale) {
  const d = sale.drop;
  const line =
    sale.phase === "upcoming" && d ? copy.drop.notOpen(formatOpensAt(d.opensAt))
    : sale.phase === "sold_out" ? copy.drop.soldOut
    : copy.drop.closed;
  return NextResponse.json({ error: sale.phase, line, opensAt: d?.opensAt }, { status: 410 });
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
    if (e instanceof ModelConfigError) {
      console.error("haggle: model config:", e.message);
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
    const ref = typeof body.ref === "string" && UUID.test(body.ref) ? body.ref : undefined;
    const sale = await onSale(String(body.item ?? ""));
    // The old book is off the shelf: only a friend's link for an open pledge still reaches it.
    if (!sale || (sale.phase === "book" && !ref)) return NextResponse.json({ error: "no_such_item" }, { status: 404 });
    if (sale.phase !== "book" && sale.phase !== "open") return notOnSale(sale);
    const { item } = sale;
    const line = opening(item.name, item.list);
    const session: Session = { id: randomUUID(), item: item.id, state: openState(item), history: [{ who: "keeper", text: displayText(line) }], exp: now + SESSION_TTL, ref };
    return NextResponse.json({
      line: displayText(line),
      action: "open",
      ask: session.state.ask,
      // Public details only. The floor never leaves the server.
      item: { id: item.id, name: item.name, blurb: item.blurb, list: item.list },
      session: seal("session", session),
    });
  }

  const session = unseal<Session>("session", body.session);
  if (!session || session.exp < now) return NextResponse.json({ error: "session_expired" }, { status: 410 });
  const sale = await onSale(session.item);
  if (!sale) return NextResponse.json({ error: "no_such_item" }, { status: 404 });
  if (sale.phase !== "book" && sale.phase !== "open") return notOnSale(sale);
  // The floor as it stands now: it climbs as copies of a drop go.
  const { item } = sale;
  const message = String(body.message ?? "").slice(0, 600).trim();
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });
  const turns = (session.turns ?? 0) + 1;
  if (turns > MAX_TURNS) return NextResponse.json({ error: "shop_closed", line: "We're closing. Come back tomorrow." }, { status: 429 });

  const intent = await readIntent(item, session.state.ask, session.history, message).catch((e) => {
    if (e instanceof ModelConfigError) throw e;
    console.error("readIntent failed, treating as chat:", (e as Error).message);
    return { kind: "chat", tone: "neutral" } as const;
  });
  let { state, decision } = step(item, liftAsk(session.state, item.floor), intent);
  const nonce = randomUUID();

  // A drop sells only the copies it has. The handshake has to get one set aside, or there's no deal.
  if (sale.drop && decision.deal) {
    if (!(await holdCopy(sale.drop.id, nonce, decision.deal.price))) {
      return NextResponse.json({ error: "sold_out", line: copy.drop.beatenToIt }, { status: 410 });
    }
  }

  // She may get bored. The engine decides; the game only happens if it's saved for single use.
  // If the store is off or down, she just keeps haggling.
  let game: Session["game"];
  const kind = session.id ? gameToOffer(item, state, decision, session.id) : undefined;
  const store = kind && gameStore();
  if (kind && store && session.id) {
    const id = randomUUID();
    try {
      await store.offer({ id, haggle: session.id, kind, seed: newSeed() });
      ({ state, decision } = offerGame(state, decision, kind));
      game = { id, kind };
    } catch (e) {
      console.error("game offer:", (e as Error).message);
    }
  }

  const line = await speak(item, decision, intent, session.history, message);

  const history: Turn[] = [...session.history, { who: "buyer" as const, text: message }, { who: "keeper" as const, text: displayText(line) }].slice(-12);
  // Saying anything else walks away from a game she offered earlier.
  const next: Session = { ...session, state, history, turns, game };

  const offer =
    decision.deal && (decision.action === "deal" || decision.action === "pledge_deal")
      ? signOffer({
          v: 1, item: item.id, deal: decision.deal, exp: now + OFFER_TTL, nonce,
          ...(decision.deal.kind === "pledge" ? { deadline: now + PLEDGE_WINDOW } : { ref: session.ref }),
        })
      : undefined;

  return NextResponse.json({
    line: displayText(line),
    action: decision.action,
    ask: decision.ask,
    mood: decision.mood,
    referralsNeeded: decision.referralsNeeded,
    deal: decision.deal,
    offer,
    offerExpiresAt: offer ? now + OFFER_TTL : undefined,
    intent,
    game,
    session: seal("session", next),
  });
}
