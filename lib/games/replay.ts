import { SNAKE, snakeStart, snakeStep, type Dir } from "./snake";
import { STACK, stackStart, stackStep } from "./stack";
import { SEED_HEX } from "./rng";

// The server's side of anti-cheat. The browser never sends a score. It sends what the player
// pressed and on which tick, plus the tick it stopped on. The server replays that from the
// seed it picked and counts the score itself.

export const GAMES = ["snake", "stack"] as const;
export type GameKind = (typeof GAMES)[number];

export const GAME_CLOCK: Record<GameKind, { tickMs: number; maxTicks: number }> = {
  snake: { tickMs: SNAKE.tickMs, maxTicks: SNAKE.maxTicks },
  stack: { tickMs: STACK.tickMs, maxTicks: STACK.maxTicks },
};

/** One press: [tick, value]. Snake: value is a direction 0..3. Stack: value is ignored (a drop). */
export type Move = [number, number];

export interface MoveLog {
  moves: Move[];
  end: number; // the tick the browser stopped on
}

export type Replay =
  | { ok: true; score: number; ticks: number }
  | { ok: false; reason: "bad_log" | "bad_seed" };

const MAX_MOVES: Record<GameKind, number> = { snake: SNAKE.maxTicks, stack: 200 };

/** Checks the shape of a log the browser sent. Anything odd fails the whole log. */
export function readLog(kind: GameKind, raw: unknown): MoveLog | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { moves, end } = raw as { moves?: unknown; end?: unknown };
  const { maxTicks } = GAME_CLOCK[kind];
  if (!Number.isInteger(end) || (end as number) < 0 || (end as number) > maxTicks) return undefined;
  if (!Array.isArray(moves) || moves.length > MAX_MOVES[kind]) return undefined;
  let last = -1;
  const out: Move[] = [];
  for (const m of moves) {
    if (!Array.isArray(m) || m.length !== 2) return undefined;
    const [t, v] = m;
    if (!Number.isInteger(t) || !Number.isInteger(v)) return undefined;
    // Ticks strictly go up, and every press happens before the stop tick.
    if (t <= last || t >= (end as number)) return undefined;
    if (kind === "snake" && (v < 0 || v > 3)) return undefined;
    if (kind === "stack" && v !== 1) return undefined;
    out.push([t, v]);
    last = t;
  }
  return { moves: out, end: end as number };
}

/** Plays the log from the seed. ticks = how long the game really lasted, in ticks. */
export function replay(kind: GameKind, seed: string, raw: unknown): Replay {
  if (!SEED_HEX.test(seed)) return { ok: false, reason: "bad_seed" };
  const log = readLog(kind, raw);
  if (!log) return { ok: false, reason: "bad_log" };
  const at = new Map(log.moves.map(([t, v]) => [t, v]));

  if (kind === "snake") {
    const s = snakeStart(seed);
    while (s.alive && s.tick < log.end) snakeStep(s, at.get(s.tick) as Dir | undefined);
    return { ok: true, score: s.score, ticks: s.tick };
  }
  const s = stackStart(seed);
  while (s.alive && s.tick < log.end) stackStep(s, at.has(s.tick));
  return { ok: true, score: s.score, ticks: s.tick };
}

/**
 * A game that lasted `ticks` must have taken at least that long on the server's clock, between
 * Start and Finish. slackMs covers the browser's timer drifting. A log made faster than real
 * time (a script, not a player) fails.
 */
export const TIME_SLACK_MS = 1500;
export function playedInRealTime(kind: GameKind, ticks: number, elapsedMs: number): boolean {
  return elapsedMs + TIME_SLACK_MS >= ticks * GAME_CLOCK[kind].tickMs;
}
