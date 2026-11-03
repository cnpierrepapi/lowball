import { NextRequest, NextResponse } from "next/server";
import { itemById } from "@/lib/catalog";
import { readClaim } from "@/lib/claim";
import { standing } from "@/lib/purchase";
import { fullText } from "@/lib/shop/content";

// The whole item, for whoever holds a claim the chain says is paid.
export async function GET(req: NextRequest) {
  const claim = readClaim(req.nextUrl.searchParams.get("token"));
  const item = claim && (await itemById(claim.item));
  if (!claim || !item) return NextResponse.json({ error: "bad_claim" }, { status: 400 });
  const s = await standing(claim);
  if (s !== "delivered") return NextResponse.json({ error: "not_yours_yet", status: s }, { status: 403 });
  const markdown = await fullText(item);
  if (!markdown) return NextResponse.json({ error: "bad_claim" }, { status: 400 });
  return NextResponse.json({ title: item.name, markdown }, { headers: { "Cache-Control": "private, no-store" } });
}
