import { toMicro } from "./engine/money";
import type { Item } from "./engine/negotiate";
import { packFloor, packList } from "./engine/drops";
import { db } from "./db";
import { shopStore, type Pack } from "./shop/store";

export interface ShelfItem extends Item {
  blurb: string;
  kind: "book" | "pack";
  file?: string; // books: served from /content once paid
}

// The first item, from before build packs. Off the shelf: nobody can start a new haggle for it,
// but its receipts still open and friends' links for open pledges still work.
export const SHELF: Record<string, ShelfItem> = {
  overlords: {
    id: "overlords",
    kind: "book",
    name: "How to Give Up and Love Your AI Overlords",
    blurb: "A survival guide written entirely in the finest AI slop.",
    file: "overlords.md",
    list: toMicro(2),
    floor: toMicro(1.1),
    referralValue: toMicro(0.25),
    maxReferrals: 6,
    maxRounds: 8,
    personality: { stubbornness: 0.6, temper: 0.7, vanity: 0.5 },
  },
};

/** A pack as something she sells. Every number comes from the engine rule, none from the model. */
export function packItem(p: Pick<Pack, "id" | "title" | "blurb" | "score">): ShelfItem {
  const list = packList(p.score);
  return {
    id: p.id,
    kind: "pack",
    name: p.title,
    blurb: p.blurb,
    list,
    floor: packFloor(list),
    referralValue: 0,
    maxReferrals: 0, // drops are cash only
    maxRounds: 8,
    personality: { stubbornness: 0.55, temper: 0.6, vanity: 0.6 },
  };
}

/** Any item by id: the old book, or a pack from the database. */
export async function itemById(id: string): Promise<ShelfItem | undefined> {
  if (Object.hasOwn(SHELF, id)) return SHELF[id];
  const d = db();
  if (!d || !/^[a-z0-9-]{3,32}$/.test(id)) return undefined;
  const p = await shopStore(d).pack(id);
  return p && packItem(p);
}
