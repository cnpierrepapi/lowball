import { rng, type Rng } from "./rng";

// Snake on a small grid. One tick moves the snake one cell. The only input is a turn,
// given as the tick it happens on. Score = food eaten.

export const SNAKE = {
  size: 15,
  tickMs: 140,
  maxTicks: 430, // about 60 seconds
};

export type Dir = 0 | 1 | 2 | 3; // up, right, down, left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

export interface SnakeState {
  body: [number, number][]; // head first
  dir: Dir;
  food: [number, number];
  score: number;
  alive: boolean;
  tick: number; // ticks played so far
  rand: Rng;
}

function placeFood(s: Pick<SnakeState, "body" | "rand">): [number, number] {
  const taken = new Set(s.body.map(([x, y]) => y * SNAKE.size + x));
  const free: number[] = [];
  for (let i = 0; i < SNAKE.size * SNAKE.size; i++) if (!taken.has(i)) free.push(i);
  const cell = free[s.rand.int(free.length)];
  return [cell % SNAKE.size, Math.floor(cell / SNAKE.size)];
}

export function snakeStart(seed: string): SnakeState {
  const mid = Math.floor(SNAKE.size / 2);
  const body: [number, number][] = [[mid, mid], [mid - 1, mid], [mid - 2, mid]];
  const rand = rng(seed);
  return { body, dir: 1, food: placeFood({ body, rand }), score: 0, alive: true, tick: 0, rand };
}

/** One tick. `turn` is the direction pressed for this tick, if any. Mutates and returns s. */
export function snakeStep(s: SnakeState, turn?: Dir): SnakeState {
  if (!s.alive) return s;
  // Turning straight back into yourself is ignored, like every snake game.
  if (turn !== undefined && (turn + 2) % 4 !== s.dir) s.dir = turn;
  s.tick += 1;
  const [hx, hy] = s.body[0];
  const nx = hx + DX[s.dir];
  const ny = hy + DY[s.dir];
  const eats = nx === s.food[0] && ny === s.food[1];
  // The tail moves out of the way this tick unless the snake is growing.
  const rest = eats ? s.body : s.body.slice(0, -1);
  const hitWall = nx < 0 || ny < 0 || nx >= SNAKE.size || ny >= SNAKE.size;
  if (hitWall || rest.some(([x, y]) => x === nx && y === ny)) {
    s.alive = false;
    return s;
  }
  s.body = [[nx, ny], ...rest];
  if (eats) {
    s.score += 1;
    if (s.body.length >= SNAKE.size * SNAKE.size) s.alive = false; // board full, nothing left to eat
    else s.food = placeFood(s);
  }
  return s;
}
