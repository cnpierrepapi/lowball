import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { SHELF } from "@/lib/catalog";
import { verifyOffer } from "@/lib/offer";
import { USDC_DEVNET, SOLANA_DEVNET, merchantAddress, resourceServer } from "@/lib/x402";

// Spent offers. In-memory for now; the onchain receipt (seeded by nonce) replaces this.
const spent = new Set<string>();

function itemIdFrom(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
}

const paid = withX402(
  async (req: NextRequest): Promise<NextResponse<unknown>> => {
    const id = itemIdFrom(req.url);
    const check = verifyOffer(req.nextUrl.searchParams.get("offer"), id);
    if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 410 });
    const { offer } = check;
    if (spent.has(offer.nonce)) return NextResponse.json({ error: "offer_used" }, { status: 409 });
    spent.add(offer.nonce);

    const item = SHELF[id];
    if (offer.deal.kind === "pledge") {
      return NextResponse.json({
        item: id,
        status: "pledged",
        paid: offer.deal.price,
        referralsNeeded: offer.deal.referrals,
      });
    }
    return NextResponse.json({ item: id, status: "delivered", paid: offer.deal.price, title: item.name });
  },
  {
    "/api/item/[id]": {
      accepts: {
        scheme: "exact",
        network: SOLANA_DEVNET,
        payTo: () => merchantAddress(),
        // The price is whatever the signed offer says, and nothing else.
        price: (ctx) => {
          const url = ctx.adapter.getUrl();
          const check = verifyOffer(new URL(url).searchParams.get("offer"), itemIdFrom(url));
          if (!check.ok) throw new Error(`offer ${check.reason}`);
          return { amount: String(check.offer.deal.price), asset: USDC_DEVNET };
        },
        maxTimeoutSeconds: 120,
      },
      description: "A Lowball item at the price you haggled",
      mimeType: "application/json",
    },
  },
  resourceServer,
);

// Bad, expired and spent offers are turned away before any payment is asked for,
// so nobody ever pays for a deal that no longer exists.
export async function GET(req: NextRequest) {
  const id = itemIdFrom(req.url);
  if (!SHELF[id]) return NextResponse.json({ error: "no_such_item" }, { status: 404 });
  const check = verifyOffer(req.nextUrl.searchParams.get("offer"), id);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 410 });
  if (spent.has(check.offer.nonce)) return NextResponse.json({ error: "offer_used" }, { status: 409 });
  return paid(req);
}
