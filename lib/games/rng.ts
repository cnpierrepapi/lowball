// A small seeded random number generator (sfc32). The browser and the server run the same
// code from the same seed, so they see the same game. Integer maths only, so every JS engine
// gives the same numbers.

export const SEED_HEX = /^[0-9a-f]{32}$/;

export interface Rng {
  /** Next whole number from 0 up to (not including) n. */
  int(n: number): number;
}

export function rng(seedHex: string): Rng {
  if (!SEED_HEX.test(seedHex)) throw new Error("bad seed");
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  let b = parseInt(seedHex.slice(8, 16), 16) >>> 0;
  let c = parseInt(seedHex.slice(16, 24), 16) >>> 0;
  let d = parseInt(seedHex.slice(24, 32), 16) >>> 0;
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  // Throw away the first few outputs so similar seeds don't start out alike.
  for (let i = 0; i < 12; i++) next();
  return { int: (n) => next() % n };
}
