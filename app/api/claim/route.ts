import { NextRequest, NextResponse } from "next/server";
import { SHELF } from "@/lib/catalog";
import { readClaim } from "@/lib/claim";
import { standing } from "@/lib/purchase";

// Gets a buyer back to what they bought, whenever they come back. The claim token proves the
// purchase is theirs; the chain says whether it went through.
export async function GET(req: NextRequest) {
  const claim = readClaim(req.nextUrl.searchParams.get("token"));
  if (!claim || !SHELF[claim.item]) return NextResponse.json({ error: "bad_claim" }, { status: 400 });
  const item = SHELF[claim.item];
  const s = await standing(claim);
  if (s === "delivered") return NextResponse.json({ item: item.id, status: s, title: item.name });
  if (s === "pledged") return NextResponse.json({ item: item.id, status: s, pledge: `/api/pledge/${claim.nonce}` });
  return NextResponse.json({ item: item.id, status: s }, { status: s === "no_receipt" || s === "unknown" ? 404 : 410 });
}
