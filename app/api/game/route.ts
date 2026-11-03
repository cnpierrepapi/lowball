import { NextRequest, NextResponse } from "next/server";
import { SHELF } from "@/lib/catalog";
import { gameResult } from "@/lib/engine/games";
import { finishGame, startGame } from "@/lib/games/play";
import { gameStore } from "@/lib/games/store";
import { GAME_CLOCK } from "@/lib/games/replay";
import { seal, unseal } from "@/lib/seal";
import { displayText, speak, type Turn } from "@/lib/shopkeeper";
import { allow, clientIp } from "@/lib/limits";
import { ModelConfigError } from "@/lib/claude";
import { ConfigError } from "@/lib/config";
import type { Session } from "@/lib/session";

// The game she asked for. Two steps:
//   start:  the server starts its clock and only now hands out the seed.
//   finish: the browser sends the moves it made, never a score. The server replays them from
//           the seed, scores them, and the engine moves the price (never under the floor).

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (!allow(`game:${ip}`, 20, 60_000)) {
    return NextResponse.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "30" } });
  }
  try {
    return await game(req);
  } catch (e) {
    if (e instanceof ModelConfigError) return NextResponse.json({ error: "shopkeeper_unavailable" }, { status: 503 });
    console.error("game:", (e as Error).message);
    return NextResponse.json({ error: e instanceof ConfigError ? "not_set_up" : "generic" }, { status: e instanceof ConfigError ? 503 : 500 });
  }
}

async function game(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const now = Math.floor(Date.now() / 1000);
  const session = unseal<Session>("session", body.session);
  if (!session || session.exp < now) return NextResponse.json({ error: "session_expired" }, { status: 410 });
  // The game has to be the one this haggle's sealed state says she offered.
  const g = session.game;
  if (!g || !session.id || body.game !== g.id) return NextResponse.json({ error: "no_game" }, { status: 410 });
  const store = gameStore();
  if (!store) return NextResponse.json({ error: "no_game" }, { status: 410 });

  if (body.op === "start") {
    const started = await startGame(store, g.id, session.id);
    if (!started) return NextResponse.json({ error: "no_game" }, { status: 410 });
    return NextResponse.json({ kind: started.kind, seed: started.seed, ...GAME_CLOCK[started.kind] });
  }

  if (body.op !== "finish") return NextResponse.json({ error: "generic" }, { status: 400 });

  const scored = await finishGame(store, g.id, session.id, body.log);
  if (!scored.ok) return NextResponse.json({ error: scored.reason === "no_game" ? "no_game" : "game_rejected" }, { status: 410 });

  const item = SHELF[session.item];
  const before = session.state.ask;
  const { state, decision } = gameResult(item, session.state, scored.kind, scored.score);
  const line = await speak(item, decision, { kind: "chat", tone: "neutral" }, session.history, "", before);
  const history: Turn[] = [...session.history, { who: "keeper" as const, text: displayText(line) }].slice(-12);
  const next: Session = { ...session, state, history, game: undefined };

  return NextResponse.json({
    line: displayText(line),
    action: decision.action,
    ask: decision.ask,
    mood: decision.mood,
    score: scored.score,
    session: seal("session", next),
  });
}
