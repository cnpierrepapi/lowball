import { NextRequest, NextResponse } from "next/server";
import { SHELF } from "@/lib/catalog";
import { readClaim } from "@/lib/claim";
import { standing } from "@/lib/purchase";
import { readItemFile } from "@/lib/book";

// The whole item, for whoever holds a claim the chain says is paid.
export async function GET(req: NextRequest) {
  const claim = readClaim(req.nextUrl.searchParams.get("token"));
  if (!claim || !SHELF[claim.item]) return NextResponse.json({ error: "bad_claim" }, { status: 400 });
  const s = await standing(claim);
  if (s !== "delivered") return NextResponse.json({ error: "not_yours_yet", status: s }, { status: 403 });
  const item = SHELF[claim.item];
  return NextResponse.json(
    { title: item.name, markdown: await readItemFile(item.file) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
