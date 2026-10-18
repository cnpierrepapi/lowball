// All money is integer micro-USDC (6 decimals), the same unit the USDC mint uses.
export const MICRO = 1_000_000;
export const CENT = 10_000;

export function toMicro(usdc: number): number {
  return Math.round(usdc * MICRO);
}

export function fromMicro(micro: number): number {
  return micro / MICRO;
}

// Asks are quoted to the cent, rounded down so a counter never overshoots the maths.
export function toCents(micro: number): number {
  return Math.floor(micro / CENT) * CENT;
}

export function formatUsdc(micro: number): string {
  return fromMicro(micro).toFixed(2);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
