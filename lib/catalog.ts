import { toMicro } from "./engine/money";
import type { Item } from "./engine/negotiate";

export interface ShelfItem extends Item {
  blurb: string;
  file: string; // served from /content once paid
}

export const SHELF: Record<string, ShelfItem> = {
  overlords: {
    id: "overlords",
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
