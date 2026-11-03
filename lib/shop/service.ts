import { db } from "../db";
import { itemById, type ShelfItem } from "../catalog";
import { dealExists } from "../chain";
import { dropFloor, type Phase } from "../engine/drops";
import { shopStore, type Drop, type IsPaid } from "./store";

// What the haggle and game routes need to know about an item right now: is it on sale, and
// where is her floor (it climbs as copies of a drop go).

export interface OnSale {
  item: ShelfItem; // with the floor as it stands now
  drop?: Drop;
  phase: Phase | "book";
}

// Paid or not, read from the onchain receipt the payment route writes. Tests swap it.
let paidCheck: IsPaid = dealExists;
export function setPaidCheck(f: IsPaid | undefined) {
  paidCheck = f ?? dealExists;
}
export const isPaid: IsPaid = (nonce) => paidCheck(nonce);

export async function onSale(itemId: string, now = Date.now()): Promise<OnSale | undefined> {
  const item = await itemById(itemId);
  if (!item) return undefined;
  if (item.kind === "book") return { item, phase: "book" };
  const d = db();
  if (!d) return undefined;
  const store = shopStore(d);
  let drop = await store.dropForPack(item.id, now);
  if (!drop) return undefined;
  // Holds whose time ran out are settled first, so the count is current.
  await store.reconcile(drop.id, new Date(now), isPaid);
  drop = (await store.drop(drop.id, now))!;
  return { item: { ...item, floor: dropFloor(item, drop.sold + drop.held, drop.copies) }, drop, phase: drop.phase };
}

/** Sets a copy aside for this handshake. False if there isn't one. */
export async function holdCopy(dropId: string, nonce: string, price: number, now = Date.now()): Promise<boolean> {
  const d = db();
  if (!d) return false;
  return shopStore(d).hold(dropId, nonce, price, new Date(now), isPaid);
}
