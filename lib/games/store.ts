import { db } from "../db";
import { GAME_CLOCK, type GameKind } from "./replay";

// Where games live between Offer, Start and Finish. Postgres (Neon) in production, memory in
// tests and local dev. Every rule that makes a game single use is in here, done in one atomic
// step each, so two requests racing for the same game can't both win.

export type Outcome = "scored" | "bad_log" | "too_fast";

export interface Started {
  kind: GameKind;
  seed: string;
}

export interface Playing {
  kind: GameKind;
  seed: string;
  haggle: string;
  elapsedMs: number; // since Start, on the store's own clock
}

export interface GameStore {
  /** Saves a new game. Throws if the store is down, so the shop just doesn't offer one. */
  offer(g: { id: string; haggle: string; kind: GameKind; seed: string }): Promise<void>;
  /** Starts the clock and hands out the seed. Only once, and only soon after the offer. */
  start(id: string, haggle: string): Promise<Started | undefined>;
  /** A started, unfinished game that's still inside its time limit. */
  playing(id: string, haggle: string): Promise<Playing | undefined>;
  /** Closes the game for good. False if it was already closed (someone got there first). */
  finish(id: string, score: number, outcome: Outcome): Promise<boolean>;
}

/** How long after the offer Start still works. */
export const START_WINDOW_MS = 10 * 60_000;
/** How long after Start Finish still works: the longest game plus a minute. */
export function finishWindowMs(kind: GameKind): number {
  return GAME_CLOCK[kind].maxTicks * GAME_CLOCK[kind].tickMs + 60_000;
}

interface Row {
  haggle: string;
  kind: GameKind;
  seed: string;
  offeredAt: number;
  startedAt?: number;
  finishedAt?: number;
  score?: number;
  outcome?: Outcome;
}

export function memoryStore(clock: () => number = Date.now): GameStore & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  return {
    rows,
    async offer(g) {
      if (rows.has(g.id)) throw new Error("duplicate game id");
      rows.set(g.id, { haggle: g.haggle, kind: g.kind, seed: g.seed, offeredAt: clock() });
    },
    async start(id, haggle) {
      const r = rows.get(id);
      const now = clock();
      if (!r || r.haggle !== haggle || r.startedAt !== undefined || now - r.offeredAt > START_WINDOW_MS) return undefined;
      r.startedAt = now;
      return { kind: r.kind, seed: r.seed };
    },
    async playing(id, haggle) {
      const r = rows.get(id);
      if (!r || r.haggle !== haggle || r.startedAt === undefined || r.finishedAt !== undefined) return undefined;
      const elapsedMs = clock() - r.startedAt;
      if (elapsedMs > finishWindowMs(r.kind)) return undefined;
      return { kind: r.kind, seed: r.seed, haggle: r.haggle, elapsedMs };
    },
    async finish(id, score, outcome) {
      const r = rows.get(id);
      if (!r || r.startedAt === undefined || r.finishedAt !== undefined) return false;
      Object.assign(r, { finishedAt: clock(), score, outcome });
      return true;
    },
  };
}

// The database's clock times Start and Finish, so serverless instances with drifting clocks
// all agree on how long a game took.
export function postgresStore(): GameStore | undefined {
  const sql = db();
  if (!sql) return undefined;
  return {
    async offer(g) {
      await sql`INSERT INTO games (id, haggle, kind, seed) VALUES (${g.id}, ${g.haggle}, ${g.kind}, ${g.seed})`;
    },
    async start(id, haggle) {
      const rows = await sql`
        UPDATE games SET started_at = now()
        WHERE id = ${id} AND haggle = ${haggle} AND started_at IS NULL
          AND offered_at > now() - make_interval(secs => ${START_WINDOW_MS / 1000})
        RETURNING kind, seed`;
      const r = rows[0] as { kind: GameKind; seed: string } | undefined;
      return r && { kind: r.kind, seed: r.seed };
    },
    async playing(id, haggle) {
      const rows = await sql`
        SELECT kind, seed, haggle, (extract(epoch FROM now() - started_at) * 1000)::float8 AS elapsed
        FROM games
        WHERE id = ${id} AND haggle = ${haggle} AND started_at IS NOT NULL AND finished_at IS NULL`;
      const r = rows[0] as { kind: GameKind; seed: string; haggle: string; elapsed: number } | undefined;
      if (!r || r.elapsed > finishWindowMs(r.kind)) return undefined;
      return { kind: r.kind, seed: r.seed, haggle: r.haggle, elapsedMs: Number(r.elapsed) };
    },
    async finish(id, score, outcome) {
      const rows = await sql`
        UPDATE games SET finished_at = now(), score = ${score}, outcome = ${outcome}
        WHERE id = ${id} AND started_at IS NOT NULL AND finished_at IS NULL
        RETURNING id`;
      return rows.length === 1;
    },
  };
}

let override: GameStore | null | undefined;
// Local dev only. Kept on globalThis because dev reloads can give each route its own copy of
// this module, and the haggle route and the game route must see the same games.
const dev = globalThis as { lowballDevGames?: GameStore };

/** For tests: put a store in, or null for "no store". undefined goes back to the default. */
export function setGameStore(s: GameStore | null | undefined) {
  override = s;
}

/**
 * The store to use, or undefined when games are off. With no DATABASE_URL, local dev gets a
 * memory store and production gets none: without the single-use rule, no games.
 */
export function gameStore(): GameStore | undefined {
  if (override !== undefined) return override ?? undefined;
  const pg = postgresStore();
  if (pg) return pg;
  if (process.env.NODE_ENV === "production") return undefined;
  dev.lowballDevGames ??= memoryStore();
  return dev.lowballDevGames;
}
