import { randomBytes } from "node:crypto";
import { playedInRealTime, replay, type GameKind } from "./replay";
import type { GameStore, Started } from "./store";

// Start and Finish, without any HTTP around them, so the tests can run every cheat through
// the exact code the route runs.

/** 128 random bits from the OS, as hex. Picked by the server, never by the browser. */
export function newSeed(): string {
  return randomBytes(16).toString("hex");
}

export async function startGame(store: GameStore, id: string, haggle: string): Promise<Started | undefined> {
  return store.start(id, haggle);
}

export type Scored =
  | { ok: true; kind: GameKind; score: number }
  | { ok: false; reason: "no_game" | "bad_log" | "too_fast" };

/**
 * Replays the browser's log and closes the game. A bad or too-fast log still closes it, with
 * a score of 0, so a cheater can't keep trying on the same game.
 */
export async function finishGame(store: GameStore, id: string, haggle: string, log: unknown): Promise<Scored> {
  const g = await store.playing(id, haggle);
  if (!g) return { ok: false, reason: "no_game" };
  const r = replay(g.kind, g.seed, log);
  if (!r.ok) {
    await store.finish(id, 0, "bad_log");
    return { ok: false, reason: "bad_log" };
  }
  if (!playedInRealTime(g.kind, r.ticks, g.elapsedMs)) {
    await store.finish(id, 0, "too_fast");
    return { ok: false, reason: "too_fast" };
  }
  // Only the first Finish counts. If another request closed it in the meantime, this one gets nothing.
  if (!(await store.finish(id, r.score, "scored"))) return { ok: false, reason: "no_game" };
  return { ok: true, kind: g.kind, score: r.score };
}
