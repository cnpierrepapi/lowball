import { NextRequest, NextResponse } from "next/server";
import { SHELF } from "@/lib/catalog";
import { readClaim } from "@/lib/claim";
import { dealExists, fetchPledge, pledgeOutcome } from "@/lib/chain";

// Gets a buyer back to what they bought, whenever they come back. The claim token proves the
// purchase is theirs; the chain says whether it went through.
export async function GET(req: NextRequest) {
  const claim = readClaim(req.nextUrl.searchParams.get("token"));
  if (!claim || !SHELF[claim.item]) return NextResponse.json({ error: "bad_claim" }, { status: 400 });
  const item = SHELF[claim.item];

  if (claim.kind === "cash") {
    if (!(await dealExists(claim.nonce))) return NextResponse.json({ error: "no_receipt" }, { status: 404 });
    return NextResponse.json({ item: item.id, status: "delivered", title: item.name });
  }

  if (await fetchPledge(claim.nonce)) {
    return NextResponse.json({ item: item.id, status: "pledged", pledge: `/api/pledge/${claim.nonce}` });
  }
  const outcome = await pledgeOutcome(claim.nonce);
  if (outcome === "released") return NextResponse.json({ item: item.id, status: "delivered", title: item.name });
  return NextResponse.json({ item: item.id, status: outcome }, { status: outcome === "unknown" ? 404 : 410 });
}
