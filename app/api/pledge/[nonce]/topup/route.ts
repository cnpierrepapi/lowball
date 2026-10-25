import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { USDC_DEVNET, SOLANA_DEVNET, resourceServer } from "@/lib/x402";
import { fetchPledge, pledgeAddress, releaseIx, send, shopSigner, usdcAccount, usdcBalance } from "@/lib/chain";

// Not enough friends? Pay the gap into the same vault and the item releases. The price is
// read from the chain (full price minus what's in the vault), so it can't be argued with.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonceFrom(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const n = parts[parts.length - 2] ?? "";
  if (!UUID.test(n)) throw new Error("bad nonce");
  return n;
}

async function gap(nonce: string): Promise<number> {
  const p = await fetchPledge(nonce);
  if (!p) throw new Error("no open pledge");
  return Math.max(0, p.fullPrice - (await usdcBalance(await usdcAccount(await pledgeAddress(nonce)))));
}

const paid = withX402(
  async (req: NextRequest): Promise<NextResponse<unknown>> =>
    NextResponse.json({ nonce: nonceFrom(req.url), status: "topped_up" }),
  {
    "/api/pledge/[nonce]/topup": {
      accepts: {
        scheme: "exact",
        network: SOLANA_DEVNET,
        payTo: (ctx) => pledgeAddress(nonceFrom(ctx.adapter.getUrl())),
        price: async (ctx) => {
          const nonce = nonceFrom(ctx.adapter.getUrl());
          return { amount: String(await gap(nonce)), asset: USDC_DEVNET, extra: { memo: `${nonce}:topup` } };
        },
        maxTimeoutSeconds: 120,
      },
      description: "Top a Lowball pledge up to the full price",
      mimeType: "application/json",
    },
  },
  resourceServer,
);

export async function GET(req: NextRequest) {
  let nonce: string;
  try {
    nonce = nonceFrom(req.url);
  } catch {
    return NextResponse.json({ error: "bad_nonce" }, { status: 400 });
  }
  const p = await fetchPledge(nonce);
  if (!p) return NextResponse.json({ error: "no_open_pledge", pledge: `/api/pledge/${nonce}` }, { status: 409 });
  if ((await gap(nonce)) === 0) return NextResponse.json({ error: "nothing_to_top_up" }, { status: 409 });

  const res = await paid(req);
  const pr = res.headers.get("PAYMENT-RESPONSE");
  if (pr && decodePaymentResponseHeader(pr).success) {
    // Release is permissionless; if it fails here, the next status read releases it.
    try {
      const auth = await shopSigner();
      await send([await releaseIx(nonce, p.merchant, auth.address)]);
    } catch (e) {
      console.error("topup release:", (e as Error).message);
    }
  }
  return res;
}
