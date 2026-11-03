import { rng, type Rng } from "./rng";

// Stack: a block slides back and forth above the tower. Tap to drop it. Whatever hangs over
// the block below is cut off. Miss completely and the game is over. Score = blocks stacked.
// The only input is a drop, given as the tick it happens on.

export const STACK = {
  width: 100, // the play area, in whole units
  startWidth: 40,
  tickMs: 40,
  maxTicks: 1500, // 60 seconds
  snap: 3, // a drop this close to perfect counts as perfect (half the top speed, so it's always reachable)
};

export interface Block {
  x: number;
  w: number;
}

export interface StackState {
  tower: Block[]; // bottom first
  layerStart: number; // tick the sliding block appeared
  speed: number; // units per tick
  fromRight: boolean;
  score: number;
  alive: boolean;
  tick: number;
  rand: Rng;
}

function newLayer(s: StackState) {
  // Faster every few layers. The seed picks the side and a little extra speed.
  s.speed = Math.min(6, 2 + Math.floor(s.score / 4) + s.rand.int(2));
  s.fromRight = s.rand.int(2) === 1;
  s.layerStart = s.tick;
}

export function stackStart(seed: string): StackState {
  const s: StackState = {
    tower: [{ x: (STACK.width - STACK.startWidth) / 2, w: STACK.startWidth }],
    layerStart: 0, speed: 2, fromRight: false, score: 0, alive: true, tick: 0, rand: rng(seed),
  };
  newLayer(s);
  return s;
}

/**
 * Where the sliding block's left edge is right now. It bounces between the walls and can
 * hang half off either side, so it can miss the tower completely.
 */
export function slidingX(s: StackState): number {
  const w = s.tower[s.tower.length - 1].w;
  const span = STACK.width;
  const d = ((s.tick - s.layerStart) * s.speed) % (2 * span);
  const x = d <= span ? d : 2 * span - d;
  return (s.fromRight ? span - x : x) - Math.floor(w / 2);
}

/** One tick. `drop` is true if the player dropped on this tick. Mutates and returns s. */
export function stackStep(s: StackState, drop = false): StackState {
  if (!s.alive) return s;
  if (drop) {
    const top = s.tower[s.tower.length - 1];
    let x = slidingX(s);
    if (Math.abs(x - top.x) <= STACK.snap) x = top.x;
    const left = Math.max(x, top.x);
    const right = Math.min(x + top.w, top.x + top.w);
    if (right - left <= 0) {
      // The miss still uses up its tick, so the drop sits inside the game, before the stop tick.
      s.tick += 1;
      s.alive = false;
      return s;
    }
    s.tower.push({ x: left, w: right - left });
    s.score += 1;
    s.tick += 1;
    newLayer(s);
    return s;
  }
  s.tick += 1;
  return s;
}
