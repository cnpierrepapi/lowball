import { clamp, toCents } from "./money";
import type { Decision, Item, State } from "./negotiate";
import type { GameKind } from "../games/replay";

// The engine decides when the shopkeeper gets bored and what a game score is worth.
// The model never sees these numbers and never picks them.

export const GAME_TARGET: Record<GameKind, number> = {
  snake: 15, // food eaten for a perfect game
  stack: 20, // blocks stacked for a perfect game
};

/** A perfect game takes this share of the gap between her ask and her floor off the ask. */
export const GAME_MAX_SHARE = 0.5;
/** She only bothers when the ask is at least this far above the floor (as a share of list). */
export const GAME_MIN_GAP = 0.05;
/** Below this mood she's too annoyed to play. */
export const GAME_MIN_MOOD = -0.5;
export const GAME_EARLIEST_ROUND = 3;

// FNV-1a. Turns the haggle's id into a stable number, so "sometimes" is fixed per haggle and
// asking again doesn't reroll it.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The round this haggle's game comes up (3, 4 or 5), and which game it is. */
export function gamePlan(haggleId: string): { round: number; kind: GameKind } {
  const h = hash(haggleId);
  return { round: GAME_EARLIEST_ROUND + (h % 3), kind: (h >>> 8) % 2 === 0 ? "snake" : "stack" };
}

/**
 * After a normal step: should she get bored now? Only when she just countered or held, the
 * haggle is open, she isn't angry, there's room above the floor, and no game has come up yet.
 * Returns the game to offer, or undefined.
 */
export function gameToOffer(item: Item, state: State, decision: Decision, haggleId: string): GameKind | undefined {
  if (state.status !== "open" || state.gameOffered) return undefined;
  if (decision.action !== "counter" && decision.action !== "hold") return undefined;
  if (state.mood <= GAME_MIN_MOOD) return undefined;
  if (state.ask - item.floor < GAME_MIN_GAP * item.list) return undefined;
  const plan = gamePlan(haggleId);
  return state.round >= plan.round ? plan.kind : undefined;
}

/** Marks the game as offered and turns her line into "entertain me". The ask doesn't change. */
export function offerGame(state: State, decision: Decision, kind: GameKind): { state: State; decision: Decision } {
  return { state: { ...state, gameOffered: true }, decision: { ...decision, action: "entertain_me", game: kind } };
}

/** The ask after a game. Never below the floor, never above the ask she had. */
export function askAfterGame(item: Item, ask: number, kind: GameKind, score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  const share = clamp(s / GAME_TARGET[kind], 0, 1) * GAME_MAX_SHARE;
  const cut = Math.max(0, ask - item.floor) * share;
  return clamp(toCents(ask - cut), item.floor, ask);
}

/** Applies a game the server replayed and scored. Only works on an open haggle. */
export function gameResult(item: Item, prev: State, kind: GameKind, score: number): { state: State; decision: Decision } {
  const s: State = { ...prev, gameOffered: true };
  if (s.status !== "open") {
    return { state: s, decision: { action: "closed", ask: s.ask, mood: s.mood, insulted: false, deal: s.deal } };
  }
  s.ask = askAfterGame(item, s.ask, kind, score);
  // A good show cheers her up a little. A bad one doesn't make her angrier.
  s.mood = clamp(s.mood + 0.15 * clamp(score / GAME_TARGET[kind], 0, 1), -1, 1);
  // Whatever she said before the game, a "deal" now means her new ask in cash.
  s.referralOnTable = false;
  return { state: s, decision: { action: "game_result", ask: s.ask, mood: s.mood, insulted: false, game: kind, score } };
}
