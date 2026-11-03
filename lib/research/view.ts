import { connection } from "next/server";
import { db } from "../db";
import { researchStore, type Lead } from "./store";
import { settings } from "./loop";
import type { Post } from "./sources";
import { shopStore } from "../shop/store";

// The notebook page's data, read on the server per request.
export async function notebook(limit = 40): Promise<{ leads: (Lead & { posts: Post[]; onchainTx?: string | null })[]; spent: number; cap: number } | undefined> {
  await connection();
  const d = db();
  if (!d) return undefined;
  const store = researchStore(d);
  const leads = await store.leads(limit);
  const posts = await store.postsByIds(leads.flatMap((l) => [...l.postIds, ...l.crossIds]));
  const byId = new Map(posts.map((p) => [p.id, p]));
  const shop = shopStore(d);
  const out = [];
  for (const l of leads) {
    const pack = l.packId ? await shop.pack(l.packId) : undefined;
    const ids = [...new Set([...l.postIds, ...l.crossIds])];
    out.push({ ...l, posts: ids.map((id) => byId.get(id)).filter((p): p is Post => Boolean(p)), onchainTx: pack?.onchainTx });
  }
  const { capUsd } = await settings(d);
  return { leads: out, spent: await store.spentThisMonth(new Date()), cap: capUsd };
}
