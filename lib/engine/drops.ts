import { clamp, toCents, toMicro } from "./money";
import type { Item, State } from "./negotiate";

// Numbers for packs and drops. The engine sets every one of them from the pack; the model
// never sees them and never picks them.

/** List price from the pack's research score (0 to 100): 1.50 USDC plus a cent a point. */
export function packList(score: number): number {
  const s = clamp(Math.round(Number.isFinite(score) ? score : 0), 0, 100);
  return toMicro(1.5) + s * toMicro(0.01);
}

/** Her secret floor for a pack: 55% of list, to the cent. */
export function packFloor(list: number): number {
  return toCents(list * 0.55);
}

/** How far toward list the floor has climbed once every copy is gone. */
export const FLOOR_RISE = 0.5;

/** The floor once `taken` of `copies` are gone: rises evenly to halfway between floor and list. */
export function dropFloor(item: Pick<Item, "floor" | "list">, taken: number, copies: number): number {
  if (copies <= 0) return item.floor;
  const share = clamp(taken / copies, 0, 1);
  return clamp(toCents(item.floor + share * FLOOR_RISE * (item.list - item.floor)), item.floor, item.list);
}

/** If the floor rose mid-haggle, her ask can't stay under it. */
export function liftAsk(state: State, floor: number): State {
  return state.ask < floor ? { ...state, ask: floor } : state;
}

export type Phase = "upcoming" | "open" | "sold_out" | "closed" | "cancelled";

export interface DropFacts {
  copies: number;
  taken: number; // sold, or held for a buyer who may still pay
  opensAt: number; // ms
  closesAt: number; // ms
  cancelled: boolean;
}

/** Where a drop stands right now. */
export function dropPhase(d: DropFacts, now: number): Phase {
  if (d.cancelled) return "cancelled";
  if (now < d.opensAt) return "upcoming";
  if (now >= d.closesAt) return "closed";
  if (d.taken >= d.copies) return "sold_out";
  return "open";
}
