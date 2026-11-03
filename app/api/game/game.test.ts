import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The whole loop through the real routes: haggle until she gets bored, start the game, play it,
// finish it. Only the two model calls are stubbed (no API key in tests): the buyer always
// offers 1 USDC, and her line is the engine's safe fallback line.
vi.mock("@/lib/shopkeeper", async (orig) => {
  const real = await orig<typeof import("@/lib/shopkeeper")>();
  return {
    ...real,
    readIntent: vi.fn(async (_i: unknown, _a: unknown, _h: unknown, msg: string) =>
      msg === "deal" ? { kind: "accept", tone: "neutral" } : { kind: "offer", tone: "polite", amount: 1 }),
    speak: vi.fn(async (_i: unknown, d: import("@/lib/engine/negotiate").Decision) => real.fallbackLine(d)),
  };
});

process.env.OFFER_SIGNING_KEY = "22".repeat(32);

const { POST: haggle } = await import("../haggle/route");
const { POST: game } = await import("./route");
const { memoryStore, setGameStore } = await import("@/lib/games/store");
const { snakeStart, snakeStep, SNAKE } = await import("@/lib/games/snake");
const { stackStart, stackStep, slidingX, STACK } = await import("@/lib/games/stack");
const { unseal } = await import("@/lib/seal");
const { testDb, wipe } = await import("@/lib/testing/pglite");
const { setDb } = await import("@/lib/db");
const { shopStore } = await import("@/lib/shop/store");
const { setPaidCheck } = await import("@/lib/shop/service");
const { itemById } = await import("@/lib/catalog");

// A pack with an open drop of 5 copies, in a real (in-memory) Postgres.
const db = await testDb();
setDb(db);
setPaidCheck(async () => false);
async function openPack() {
  const shop = shopStore(db);
  await shop.addPack({ id: "test-pack", title: "Test Pack", blurb: "A pack for tests.", teaser: "free", body: "paid", score: 50, leadId: null });
  await shop.schedule({ packId: "test-pack", copies: 5, opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 86_400_000) });
}

let t = 5_000_000;
let store: ReturnType<typeof memoryStore>;
let ip = 0;

const post = (route: (r: NextRequest) => Promise<Response>, body: unknown) =>
  route(new NextRequest("http://shop/api", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": `10.0.0.${ip}` } }))
    .then(async (r) => ({ status: r.status, j: await r.json() }));

/** Haggles until she offers a game. Returns the session holding it. */
async function untilBored() {
  let r = await post(haggle, { item: "test-pack" });
  for (let i = 0; i < 8; i++) {
    r = await post(haggle, { session: r.j.session, message: "1 USDC?" });
    if (r.j.game) return r.j;
  }
  throw new Error("she never got bored");
}

/** Plays a decent game for real: Snake heads for food, Stack drops on time. */
function play(kind: "snake" | "stack", seed: string) {
  const moves: [number, number][] = [];
  if (kind === "snake") {
    const s = snakeStart(seed);
    const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
    while (s.alive && s.tick < SNAKE.maxTicks && s.score < 6) {
      const [hx, hy] = s.body[0];
      const want = [s.food[0] > hx ? 1 : 3, s.food[1] > hy ? 2 : 0, 0, 1, 2, 3].filter((d) => (d + 2) % 4 !== s.dir);
      const d = want.find((o) => {
        const nx = hx + DX[o], ny = hy + DY[o];
        return nx >= 0 && ny >= 0 && nx < SNAKE.size && ny < SNAKE.size && !s.body.slice(0, -1).some(([x, y]) => x === nx && y === ny);
      }) ?? s.dir;
      if (d !== s.dir) moves.push([s.tick, d]);
      snakeStep(s, d as 0 | 1 | 2 | 3);
    }
    return { log: { moves, end: s.tick }, ms: s.tick * SNAKE.tickMs };
  }
  const s = stackStart(seed);
  while (s.alive && s.score < 8) {
    const drop = Math.abs(slidingX(s) - s.tower[s.tower.length - 1].x) <= STACK.snap;
    if (drop) moves.push([s.tick, 1]);
    stackStep(s, drop);
  }
  return { log: { moves, end: s.tick }, ms: s.tick * STACK.tickMs };
}

beforeAll(async () => {
  await wipe(db);
  await openPack();
});

beforeEach(() => {
  store = memoryStore(() => t);
  setGameStore(store);
  ip += 1; // fresh rate-limit bucket per test
});

describe("games through the routes", () => {
  it("bored, start, play, finish: her price drops, and stays at or above the floor", async () => {
    const bored = await untilBored();
    expect(bored.action).toBe("entertain_me");
    expect(bored.game.kind).toMatch(/snake|stack/);
    expect(JSON.stringify(bored)).not.toMatch(/seed/); // no seed before Start

    const start = await post(game, { op: "start", session: bored.session, game: bored.game.id });
    expect(start.status).toBe(200);
    const { log, ms } = play(start.j.kind, start.j.seed);
    t += ms;
    const done = await post(game, { op: "finish", session: bored.session, game: bored.game.id, log });
    expect(done.status).toBe(200);
    expect(done.j.score).toBeGreaterThan(0);
    expect(done.j.ask).toBeLessThan(bored.ask);
    expect(done.j.ask).toBeGreaterThanOrEqual((await itemById("test-pack"))!.floor);

    // Shaking on it now is a cash deal at the new price.
    const deal = await post(haggle, { session: done.j.session, message: "deal" });
    expect(deal.j.deal).toEqual({ kind: "cash", price: done.j.ask });
  });

  it("finishing twice gets nothing the second time", async () => {
    const bored = await untilBored();
    const start = await post(game, { op: "start", session: bored.session, game: bored.game.id });
    const { log, ms } = play(start.j.kind, start.j.seed);
    t += ms;
    expect((await post(game, { op: "finish", session: bored.session, game: bored.game.id, log })).status).toBe(200);
    expect((await post(game, { op: "finish", session: bored.session, game: bored.game.id, log })).status).toBe(410);
  });

  it("a game id from someone else's haggle is refused", async () => {
    const mine = await untilBored();
    const theirs = await untilBored();
    expect((await post(game, { op: "start", session: mine.session, game: theirs.game.id })).j.error).toBe("no_game");
  });

  it("a session token that's been tampered with is refused", async () => {
    const bored = await untilBored();
    const forged = bored.session.slice(0, -4) + "AAAA";
    expect((await post(game, { op: "start", session: forged, game: bored.game.id })).status).toBe(410);
  });

  it("a score the browser sends is ignored; a log sent too fast earns nothing", async () => {
    const bored = await untilBored();
    const start = await post(game, { op: "start", session: bored.session, game: bored.game.id });
    const { log } = play(start.j.kind, start.j.seed);
    t += 200;
    const r = await post(game, { op: "finish", session: bored.session, game: bored.game.id, log, score: 99 });
    expect(r).toEqual({ status: 410, j: { error: "game_rejected" } });
  });

  it("saying anything else walks away from the game", async () => {
    const bored = await untilBored();
    const next = await post(haggle, { session: bored.session, message: "1 USDC?" });
    expect(next.j.game).toBeUndefined();
    expect((await post(game, { op: "start", session: next.j.session, game: bored.game.id })).j.error).toBe("no_game");
  });

  it("only one game per haggle", async () => {
    const bored = await untilBored();
    let r = await post(haggle, { session: bored.session, message: "1 USDC?" });
    for (let i = 0; i < 4; i++) {
      r = await post(haggle, { session: r.j.session, message: "1 USDC?" });
      expect(r.j.game).toBeUndefined();
    }
  });

  it("with no store (production without a database), she never offers a game", async () => {
    setGameStore(null);
    let r = await post(haggle, { item: "test-pack" });
    for (let i = 0; i < 7; i++) {
      r = await post(haggle, { session: r.j.session, message: "1 USDC?" });
      expect(r.j.game).toBeUndefined();
    }
  });

  it("if the database fails while offering, the haggle carries on without a game", async () => {
    setGameStore({ ...store, offer: async () => { throw new Error("db down"); } });
    let r = await post(haggle, { item: "test-pack" });
    for (let i = 0; i < 7; i++) {
      r = await post(haggle, { session: r.j.session, message: "1 USDC?" });
      expect(r.status).toBe(200);
      expect(r.j.game).toBeUndefined();
      expect(unseal<{ state: { gameOffered?: boolean } }>("session", r.j.session)!.state.gameOffered).toBeFalsy();
    }
  });
});
