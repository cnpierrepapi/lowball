"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { copy } from "@/lib/copy";
import { SNAKE, snakeStart, snakeStep, type Dir, type SnakeState } from "@/lib/games/snake";
import { STACK, slidingX, stackStart, stackStep, type StackState } from "@/lib/games/stack";
import type { GameKind, Move } from "@/lib/games/replay";
import type { Sounds } from "@/lib/client/sounds";

// The game she asked for. This runs the exact same game code as the server, from the seed the
// server hands out at Start, and only draws it. It records what the player pressed and on which
// tick, and sends that. It never sends a score: the server replays the moves and counts.

export interface GameReply {
  line: string;
  action: string;
  ask: number;
  mood: number;
  score: number;
  session: string;
}

interface Props {
  kind: GameKind;
  id: string;
  session: string;
  sounds: RefObject<Sounds | null>;
  onDone: (r: GameReply) => void;
  onError: (code: string) => void;
  onClose: () => void;
}

type Phase = "starting" | "countdown" | "playing" | "sending";

const INK = "#151311";
const PAPER = "#fff6ea";
const RED = "#ff4a24";
const GREEN = "#19a866";

export function Game({ kind, id, session, sounds, onDone, onError, onClose }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [count, setCount] = useState(3);
  const [score, setScore] = useState(0);
  const [left, setLeft] = useState(0);
  const stop = useRef<() => void>(() => {});
  const press = useRef<(v?: Dir) => void>(() => {});

  useEffect(() => {
    let dead = false;
    let raf = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    async function finish(moves: Move[], end: number) {
      setPhase("sending");
      try {
        const r = await fetch("/api/game", {
          method: "POST",
          body: JSON.stringify({ op: "finish", session, game: id, log: { moves, end } }),
        });
        const j = await r.json();
        if (dead) return;
        if (!r.ok) onError(j.error);
        else onDone(j);
      } catch {
        if (!dead) onError("generic");
      }
    }

    async function begin() {
      let seed: string;
      try {
        const r = await fetch("/api/game", { method: "POST", body: JSON.stringify({ op: "start", session, game: id }) });
        const j = await r.json();
        if (!r.ok) return onError(j.error);
        seed = j.seed;
      } catch {
        return onError("generic");
      }
      if (dead) return;

      const tickMs = kind === "snake" ? SNAKE.tickMs : STACK.tickMs;
      const maxTicks = kind === "snake" ? SNAKE.maxTicks : STACK.maxTicks;
      const snake = kind === "snake" ? snakeStart(seed) : undefined;
      const stack = kind === "stack" ? stackStart(seed) : undefined;
      const moves: Move[] = [];
      const turns: Dir[] = [];
      let drop = false;
      let over = false;
      let t0 = 0;
      const tick = () => (snake ?? stack)!.tick;
      const alive = () => (snake ?? stack)!.alive;

      press.current = (v) => {
        if (snake && v !== undefined && turns.length < 3) turns.push(v);
        if (stack) drop = true;
      };
      const end = () => {
        if (over) return;
        over = true;
        cancelAnimationFrame(raf);
        if (!alive()) sounds.current?.play("crash");
        finish(moves, tick());
      };
      stop.current = end;

      setPhase("countdown");
      draw(canvas.current, snake, stack);
      for (let i = 1; i <= 3; i++) timers.push(setTimeout(() => setCount(3 - i), i * 700));
      timers.push(setTimeout(() => {
        if (dead) return;
        setPhase("playing");
        t0 = performance.now();
        const frame = (now: number) => {
          if (over || dead) return;
          let due = Math.floor((now - t0) / tickMs);
          // Never run ahead of real time. If the tab was hidden, pause instead of catching up.
          if (due - tick() > 5) {
            t0 = now - tick() * tickMs;
            due = tick();
          }
          while (tick() < due && alive() && tick() < maxTicks) {
            const at = tick();
            if (snake) {
              const turn = turns.shift();
              if (turn !== undefined) moves.push([at, turn]);
              const before = snake.score;
              snakeStep(snake, turn);
              if (snake.score > before) sounds.current?.play("point");
            } else if (stack) {
              const d = drop;
              drop = false;
              if (d) moves.push([at, 1]);
              const before = stack.score;
              stackStep(stack, d);
              if (stack.score > before) sounds.current?.play("point");
            }
          }
          setScore((snake ?? stack)!.score);
          setLeft(Math.max(0, Math.ceil(((maxTicks - tick()) * tickMs) / 1000)));
          draw(canvas.current, snake, stack);
          if (!alive() || tick() >= maxTicks) end();
          else raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
      }, 2100));
    }

    begin();
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
    // One game per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keys: arrows or WASD steer the snake; space or enter drops a block.
  useEffect(() => {
    const keys: Record<string, Dir> = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3, w: 0, d: 1, s: 2, a: 3 };
    const onKey = (e: KeyboardEvent) => {
      if (kind === "snake" && e.key in keys) {
        e.preventDefault();
        press.current(keys[e.key]);
      } else if (kind === "stack" && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        press.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind]);

  // Touch: swipe to steer, tap to drop.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY };
    if (kind === "stack") press.current();
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const from = touch.current;
    const t = e.changedTouches[0];
    touch.current = null;
    if (kind !== "snake" || !from) return;
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    press.current(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={copy.game.names[kind]} className="fixed inset-0 z-50 flex items-center justify-center bg-[#151311]/60 p-4">
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border-2 border-[#151311] bg-white p-4 shadow-[6px_6px_0_#ff4a24]">
        <div className="flex items-baseline justify-between">
          <p className="font-display text-2xl font-extrabold">{copy.game.names[kind]}</p>
          <p className="font-mono text-sm font-bold">
            {copy.game.score(score)}
            {phase === "playing" && <span className="ml-3 text-[#151311]/60">{copy.game.secondsLeft(left)}</span>}
          </p>
        </div>
        <p className="text-sm">{copy.game.how[kind]}</p>
        <div className="relative">
          <canvas
            ref={canvas}
            width={600}
            height={600}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onMouseDown={() => kind === "stack" && press.current()}
            className="aspect-square w-full touch-none rounded-xl border-2 border-[#151311] bg-[#fff6ea]"
          />
          {phase !== "playing" && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/70 p-6 text-center font-display text-xl font-extrabold">
              {phase === "starting" ? copy.game.starting : phase === "countdown" ? copy.game.countdown(Math.max(1, count)) : copy.game.sending}
            </div>
          )}
        </div>
        <p className="text-xs text-[#151311]/60">{copy.game.note}</p>
        {phase === "playing" ? (
          <button onClick={() => stop.current()} className="rounded-full border-2 border-[#151311] py-2 font-bold">{copy.game.stop}</button>
        ) : phase === "starting" ? (
          <button onClick={onClose} className="rounded-full border-2 border-[#151311] py-2 font-bold">{copy.game.close}</button>
        ) : null}
      </div>
    </div>
  );
}

function draw(c: HTMLCanvasElement | null, snake?: SnakeState, stack?: StackState) {
  const g = c?.getContext("2d");
  if (!c || !g) return;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, c.width, c.height);

  if (snake) {
    const cell = c.width / SNAKE.size;
    g.fillStyle = RED;
    g.beginPath();
    g.arc((snake.food[0] + 0.5) * cell, (snake.food[1] + 0.5) * cell, cell * 0.35, 0, Math.PI * 2);
    g.fill();
    snake.body.forEach(([x, y], i) => {
      g.fillStyle = i === 0 ? INK : snake.alive ? GREEN : "#8a8580";
      g.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    });
    return;
  }

  if (stack) {
    const unit = c.width / STACK.width;
    const h = 30;
    // The camera follows the tower up: the sliding block sits a third of the way down.
    const shown = Math.min(stack.tower.length, Math.floor((c.height * 2) / 3 / h));
    const base = stack.tower.length - shown;
    for (let i = base; i < stack.tower.length; i++) {
      const b = stack.tower[i];
      const y = c.height - (i - base + 1) * h;
      g.fillStyle = i === 0 ? INK : i % 2 ? RED : GREEN;
      g.fillRect(b.x * unit, y, b.w * unit, h - 2);
    }
    if (stack.alive) {
      const top = stack.tower[stack.tower.length - 1];
      const y = c.height - (shown + 1) * h;
      g.fillStyle = INK;
      g.fillRect(slidingX(stack) * unit, y, top.w * unit, h - 2);
    }
  }
}
