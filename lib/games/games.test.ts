import { describe, expect, it } from "vitest";
import { rng } from "./rng";
import { SNAKE, snakeStart, snakeStep, type Dir, type SnakeState } from "./snake";
import { STACK, slidingX, stackStart, stackStep } from "./stack";
import { GAME_CLOCK, TIME_SLACK_MS, playedInRealTime, readLog, replay, type Move } from "./replay";
import { finishWindowMs, memoryStore, START_WINDOW_MS } from "./store";
import { finishGame, newSeed, startGame } from "./play";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

// A player with perfect reflexes: heads for the food and never steps into a wall or itself
// if it can help it. Used to make real, high-scoring logs.
function snakeBot(seed: string, maxTicks = SNAKE.maxTicks): { moves: Move[]; end: number; score: number } {
  const s = snakeStart(seed);
  const moves: Move[] = [];
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  const safe = (st: SnakeState, d: number) => {
    const [hx, hy] = st.body[0];
    const nx = hx + DX[d], ny = hy + DY[d];
    if (nx < 0 || ny < 0 || nx >= SNAKE.size || ny >= SNAKE.size) return false;
    return !st.body.slice(0, -1).some(([x, y]) => x === nx && y === ny);
  };
  while (s.alive && s.tick < maxTicks) {
    const [hx, hy] = s.body[0];
    const [fx, fy] = s.food;
    const want: number[] = [];
    if (fx > hx) want.push(1);
    if (fx < hx) want.push(3);
    if (fy > hy) want.push(2);
    if (fy < hy) want.push(0);
    const options = [...want, s.dir, 0, 1, 2, 3].filter((d) => (d + 2) % 4 !== s.dir);
    const d = options.find((o) => safe(s, o)) ?? s.dir;
    if (d !== s.dir) moves.push([s.tick, d]);
    snakeStep(s, d as Dir);
  }
  return { moves, end: s.tick, score: s.score };
}

// A perfect stacker: drops when the block lines up with the one below.
function stackBot(seed: string, layers: number): { moves: Move[]; end: number; score: number } {
  const s = stackStart(seed);
  const moves: Move[] = [];
  while (s.alive && s.score < layers && s.tick < STACK.maxTicks) {
    const top = s.tower[s.tower.length - 1];
    const drop = Math.abs(slidingX(s) - top.x) <= STACK.snap;
    if (drop) moves.push([s.tick, 1]);
    stackStep(s, drop);
  }
  return { moves, end: s.tick, score: s.score };
}

describe("seeded random numbers", () => {
  it("gives the same numbers from the same seed, and different ones from another", () => {
    const a1 = rng(A), a2 = rng(A), b = rng(B);
    const xs = Array.from({ length: 50 }, () => a1.int(1000));
    expect(Array.from({ length: 50 }, () => a2.int(1000))).toEqual(xs);
    expect(Array.from({ length: 50 }, () => b.int(1000))).not.toEqual(xs);
  });
  it("refuses a seed that isn't 32 hex characters", () => {
    expect(() => rng("abc")).toThrow();
    expect(() => rng(A.toUpperCase())).toThrow();
  });
  it("new seeds are 128 random bits and don't repeat", () => {
    const seeds = new Set(Array.from({ length: 200 }, newSeed));
    expect(seeds.size).toBe(200);
    for (const s of seeds) expect(s).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("snake replay", () => {
  it("a real game replays to the same score, every time", () => {
    const bot = snakeBot(A);
    expect(bot.score).toBeGreaterThan(5);
    const r1 = replay("snake", A, bot);
    const r2 = replay("snake", A, JSON.parse(JSON.stringify(bot)));
    expect(r1).toEqual({ ok: true, score: bot.score, ticks: bot.end });
    expect(r2).toEqual(r1);
  });

  it("ignores a score the browser claims", () => {
    const bot = snakeBot(A, 40);
    const r = replay("snake", A, { ...bot, score: 999 });
    expect(r.ok && r.score).toBe(bot.score);
  });

  it("a winning log from one game is worth little on another seed", () => {
    const bot = snakeBot(A);
    const other = replay("snake", B, bot);
    expect(other.ok).toBe(true);
    expect(other.ok && other.score).toBeLessThan(bot.score / 3);
  });

  it("an empty log runs straight into the wall", () => {
    const r = replay("snake", A, { moves: [], end: SNAKE.maxTicks });
    expect(r).toEqual({ ok: true, score: expect.any(Number), ticks: Math.ceil(SNAKE.size / 2) });
  });

  it("stopping early ends the game there, with the score so far", () => {
    const bot = snakeBot(A);
    const half = Math.floor(bot.end / 2);
    const r = replay("snake", A, { moves: bot.moves.filter(([t]) => t < half), end: half });
    expect(r.ok && r.ticks).toBe(half);
    expect(r.ok && r.score).toBeLessThanOrEqual(bot.score);
  });

  it("turning straight back is ignored, not a way to cheat death", () => {
    const s = snakeStart(A);
    snakeStep(s, 3); // heading right, pressing left
    expect(s.dir).toBe(1);
    expect(s.alive).toBe(true);
  });
});

describe("stack replay", () => {
  it("a real game replays to the same score", () => {
    const bot = stackBot(A, 25);
    expect(bot.score).toBe(25);
    expect(replay("stack", A, bot)).toEqual({ ok: true, score: 25, ticks: bot.end });
  });

  it("the same drop times on another seed fall apart", () => {
    const bot = stackBot(A, 25);
    const r = replay("stack", B, bot);
    expect(r.ok && r.score).toBeLessThan(10);
  });

  it("a drop that misses the tower ends the game", () => {
    const s = stackStart(A);
    // Wait until the block is fully off to one side of the tower, then drop.
    const top = s.tower[0];
    for (let i = 0; i < 500 && Math.abs(slidingX(s) - top.x) < top.w; i++) stackStep(s);
    stackStep(s, true);
    expect(s.alive).toBe(false);
    expect(s.score).toBe(0);
  });

  it("a game that ends on a miss replays cleanly (the browser's log isn't refused)", () => {
    const s = stackStart(A);
    const moves: Move[] = [];
    const top = s.tower[0];
    for (let i = 0; i < 500 && Math.abs(slidingX(s) - top.x) < top.w; i++) stackStep(s);
    moves.push([s.tick, 1]);
    stackStep(s, true);
    expect(s.alive).toBe(false);
    expect(replay("stack", A, { moves, end: s.tick })).toEqual({ ok: true, score: 0, ticks: s.tick });
  });

  it("a snake game that ends in a crash replays cleanly too", () => {
    const s = snakeStart(A);
    const moves: Move[] = [[0, 0]];
    snakeStep(s, 0);
    while (s.alive) snakeStep(s);
    expect(replay("snake", A, { moves, end: s.tick })).toEqual({ ok: true, score: s.score, ticks: s.tick });
  });

  it("overhang is cut off, so the tower only gets narrower", () => {
    const s = stackStart(A);
    for (let i = 0; i < 7; i++) stackStep(s);
    stackStep(s, true);
    for (let i = 1; i < s.tower.length; i++) expect(s.tower[i].w).toBeLessThanOrEqual(s.tower[i - 1].w);
  });
});

describe("move logs the server refuses", () => {
  const ok = { moves: [[3, 2], [5, 1]], end: 10 };
  const bad: [string, unknown][] = [
    ["not an object", "moves"],
    ["no end", { moves: [] }],
    ["end past the time limit", { moves: [], end: SNAKE.maxTicks + 1 }],
    ["negative end", { moves: [], end: -1 }],
    ["fractional end", { moves: [], end: 9.5 }],
    ["moves not a list", { moves: "3,2", end: 10 }],
    ["ticks going backwards", { moves: [[5, 2], [3, 1]], end: 10 }],
    ["two presses on one tick", { moves: [[3, 2], [3, 1]], end: 10 }],
    ["a press after the stop tick", { moves: [[10, 2]], end: 10 }],
    ["a direction that doesn't exist", { moves: [[3, 4]], end: 10 }],
    ["a negative tick", { moves: [[-1, 2]], end: 10 }],
    ["a fractional tick", { moves: [[1.5, 2]], end: 10 }],
    ["a string for a number", { moves: [["3", 2]], end: 10 }],
    ["an extra field in a move", { moves: [[3, 2, 99]], end: 10 }],
  ];
  it("accepts a well formed log", () => expect(readLog("snake", ok)).toBeTruthy());
  for (const [name, log] of bad) {
    it(`refuses ${name}`, () => {
      expect(readLog("snake", log)).toBeUndefined();
      expect(replay("snake", A, log)).toEqual({ ok: false, reason: "bad_log" });
    });
  }
  it("refuses a log with more presses than the game allows, even if each one is valid", () => {
    const drops = (n: number) => ({ moves: Array.from({ length: n }, (_, i) => [i * 2, 1]), end: STACK.maxTicks });
    expect(readLog("stack", drops(200))).toBeTruthy();
    expect(readLog("stack", drops(201))).toBeUndefined();
  });
  it("refuses a stack drop with any value but 1", () => {
    expect(readLog("stack", { moves: [[3, 0]], end: 10 })).toBeUndefined();
  });
  it("refuses a seed that isn't hex", () => {
    expect(replay("snake", "nope", ok)).toEqual({ ok: false, reason: "bad_seed" });
  });
});

describe("real time", () => {
  it("a game can't be finished faster than it was played", () => {
    const ticks = 300;
    const needed = ticks * GAME_CLOCK.snake.tickMs;
    expect(playedInRealTime("snake", ticks, needed)).toBe(true);
    expect(playedInRealTime("snake", ticks, needed - TIME_SLACK_MS)).toBe(true);
    expect(playedInRealTime("snake", ticks, needed - TIME_SLACK_MS - 1)).toBe(false);
    expect(playedInRealTime("snake", ticks, 0)).toBe(false);
  });
});

describe("start and finish, single use", () => {
  function setup() {
    let t = 1_000_000;
    const clock = { now: () => t, wait: (ms: number) => { t += ms; } };
    const store = memoryStore(clock.now);
    return { store, clock };
  }
  const H = "haggle-1";

  it("a fair game scores, and the second finish gets nothing", async () => {
    const { store, clock } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    const s = await startGame(store, "g", H);
    expect(s).toEqual({ kind: "snake", seed: A });
    const bot = snakeBot(A);
    clock.wait(bot.end * SNAKE.tickMs);
    expect(await finishGame(store, "g", H, bot)).toEqual({ ok: true, kind: "snake", score: bot.score });
    expect(await finishGame(store, "g", H, bot)).toEqual({ ok: false, reason: "no_game" });
  });

  it("start works once: no second clock, no second look at the seed", async () => {
    const { store } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    expect(await startGame(store, "g", H)).toBeTruthy();
    expect(await startGame(store, "g", H)).toBeUndefined();
  });

  it("a game can't be started too long after it was offered", async () => {
    const { store, clock } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    clock.wait(START_WINDOW_MS + 1);
    expect(await startGame(store, "g", H)).toBeUndefined();
  });

  it("a game can't be finished without being started", async () => {
    const { store } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    expect(await finishGame(store, "g", H, { moves: [], end: 1 })).toEqual({ ok: false, reason: "no_game" });
  });

  it("a game can't be finished long after the clock ran out", async () => {
    const { store, clock } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    await startGame(store, "g", H);
    clock.wait(finishWindowMs("snake") + 1);
    expect(await finishGame(store, "g", H, snakeBot(A))).toEqual({ ok: false, reason: "no_game" });
  });

  it("another haggle can't start or finish this game", async () => {
    const { store, clock } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    expect(await startGame(store, "g", "someone-else")).toBeUndefined();
    await startGame(store, "g", H);
    clock.wait(60_000);
    expect(await finishGame(store, "g", "someone-else", snakeBot(A))).toEqual({ ok: false, reason: "no_game" });
  });

  it("a log sent faster than real time earns nothing and burns the game", async () => {
    const { store, clock } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    await startGame(store, "g", H);
    const bot = snakeBot(A);
    clock.wait(500); // a script, not a player
    expect(await finishGame(store, "g", H, bot)).toEqual({ ok: false, reason: "too_fast" });
    clock.wait(bot.end * SNAKE.tickMs);
    expect(await finishGame(store, "g", H, bot)).toEqual({ ok: false, reason: "no_game" });
    expect(store.rows.get("g")).toMatchObject({ score: 0, outcome: "too_fast" });
  });

  it("a forged log earns nothing and burns the game", async () => {
    const { store, clock } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    await startGame(store, "g", H);
    clock.wait(30_000);
    expect(await finishGame(store, "g", H, { score: 15 })).toEqual({ ok: false, reason: "bad_log" });
    expect(await finishGame(store, "g", H, snakeBot(A))).toEqual({ ok: false, reason: "no_game" });
  });

  it("a great log copied from another game scores what it scores on this seed, not there", async () => {
    const { store, clock } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: B });
    await startGame(store, "g", H);
    const copied = snakeBot(A);
    clock.wait(copied.end * SNAKE.tickMs);
    const r = await finishGame(store, "g", H, copied);
    expect(r.ok && r.score).toBeLessThan(copied.score / 3);
  });

  it("two finishes racing for one game: only one wins", async () => {
    const { store, clock } = setup();
    await store.offer({ id: "g", haggle: H, kind: "stack", seed: A });
    await startGame(store, "g", H);
    const bot = stackBot(A, 10);
    clock.wait(bot.end * STACK.tickMs);
    const results = await Promise.all([finishGame(store, "g", H, bot), finishGame(store, "g", H, bot)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("an id can only be offered once", async () => {
    const { store } = setup();
    await store.offer({ id: "g", haggle: H, kind: "snake", seed: A });
    await expect(store.offer({ id: "g", haggle: H, kind: "snake", seed: B })).rejects.toThrow();
  });
});
