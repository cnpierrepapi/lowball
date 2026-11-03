import { connection } from "next/server";
import { db } from "../db";
import { shopStore, type Drop } from "./store";
import { isPaid } from "./service";
import type { SaleInfo } from "@/components/shop/Shop";

// What the pages show, read on the server per request. The browser never talks to the database.

export interface ShelfCard {
  packId: string;
  title: string;
  blurb: string;
  score: number;
  sale: SaleInfo;
}

function saleOf(d: Drop): SaleInfo {
  return { phase: d.phase, opensAt: d.opensAt, copies: d.copies, left: Math.max(0, d.copies - d.sold - d.held) };
}

/** Every drop that isn't cancelled: open first, then upcoming, then the rest. */
export async function shelf(): Promise<ShelfCard[]> {
  await connection();
  const d = db();
  if (!d) return [];
  const store = shopStore(d);
  const now = Date.now();
  const drops = (await store.drops(now)).filter((x) => !x.cancelled);
  // Settle expired holds so "n left" is current.
  for (const x of drops) if (x.phase === "open" || x.phase === "sold_out") await store.reconcile(x.id, new Date(now), isPaid).catch(() => undefined);
  const fresh = (await store.drops(now)).filter((x) => !x.cancelled);
  const order = { open: 0, upcoming: 1, sold_out: 2, closed: 3, cancelled: 4 } as const;
  return fresh
    .sort((a, b) => order[a.phase] - order[b.phase] || b.opensAt.localeCompare(a.opensAt))
    .map((x) => ({ packId: x.packId, title: x.title, blurb: x.blurb, score: x.score, sale: saleOf(x) }));
}

/** One pack's page: its public details and where its drop stands. */
export async function packPage(id: string): Promise<{ id: string; title: string; blurb: string; score: number; sale?: SaleInfo } | undefined> {
  await connection();
  const d = db();
  if (!d || !/^[a-z0-9-]{3,32}$/.test(id)) return undefined;
  const store = shopStore(d);
  const p = await store.pack(id);
  if (!p) return undefined;
  const drop = await store.dropForPack(id, Date.now());
  return { id: p.id, title: p.title, blurb: p.blurb, score: p.score, sale: drop ? saleOf(drop) : undefined };
}
