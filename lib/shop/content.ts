import { db } from "../db";
import { readItemFile, sampleOf } from "../book";
import type { ShelfItem } from "../catalog";
import { shopStore } from "./store";

// What a buyer reads. The old book is a file; a pack is in the database, teaser then body.

export async function fullText(item: ShelfItem): Promise<string | undefined> {
  if (item.kind === "book") return item.file ? readItemFile(item.file) : undefined;
  const d = db();
  const p = d && (await shopStore(d).pack(item.id));
  return p ? `${p.teaser}\n\n${p.body}` : undefined;
}

/** The free part: the book's opening, or the pack's teaser (the problem, the evidence, the whitespace). */
export async function freeText(item: ShelfItem): Promise<string | undefined> {
  if (item.kind === "book") return item.file ? sampleOf(await readItemFile(item.file)) : undefined;
  const d = db();
  const p = d && (await shopStore(d).pack(item.id));
  return p?.teaser;
}
