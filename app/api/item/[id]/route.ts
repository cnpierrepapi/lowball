import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { decodeTransactionFromPayload, getTokenPayerFromTransaction, type ExactSvmPayloadV1 } from "@x402/svm";
import { address, type Address } from "@solana/kit";
import { SHELF } from "@/lib/catalog";
import { verifyOffer, type Offer } from "@/lib/offer";
import { claimFor } from "@/lib/claim";
import { USDC_DEVNET, SOLANA_DEVNET, merchantAddress, resourceServer } from "@/lib/x402";
import {
  cancelPledgeIx, dealExists, fetchPledge, findPaymentByMemo, openPledgeIx, pledgeAddress, recordDealIx,
  recordReferralIx, releaseIx, send, shopSigner, usdcAccount, usdcBalance,
} from "@/lib/chain";
import { ConfigError } from "@/lib/config";

// Offers being paid right now, so the same offer can't be paid twice at once on this instance.
// Everything else about whether an offer was used is read from the chain.
const inflight = new Set<string>();

function itemIdFrom(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
}

function offerFrom(url: string): Offer {
  const check = verifyOffer(new URL(url).searchParams.get("offer"), itemIdFrom(url));
  if (!check.ok) throw new Error(`offer ${check.reason}`);
  return check.offer;
}

function delivered(offer: Offer, extra: Record<string, unknown> = {}) {
  return NextResponse.json({
    item: offer.item, status: "delivered", paid: offer.deal.price, title: SHELF[offer.item].name, claim: claimFor(offer), ...extra,
  });
}

function pledged(offer: Offer) {
  const d = offer.deal as { referrals: number };
  return NextResponse.json({
    item: offer.item, status: "pledged", paid: offer.deal.price, referralsNeeded: d.referrals,
    deadline: offer.deadline, link: `/r/${offer.nonce}`, claim: claimFor(offer),
  });
}

// Runs after the facilitator verified the payment and before it settles. A non-2xx here
// means no settle, so nobody pays for a response they didn't get.
const paid = withX402(
  async (req: NextRequest): Promise<NextResponse<unknown>> => {
    const offer = offerFrom(req.url);
    return offer.deal.kind === "pledge" ? pledged(offer) : delivered(offer);
  },
  {
    "/api/item/[id]": {
      accepts: {
        scheme: "exact",
        network: SOLANA_DEVNET,
        // Cash goes to the merchant. A pledge goes into its own vault, owned by the pledge PDA,
        // where only the program's release or refund can move it.
        payTo: async (ctx) => {
          const offer = offerFrom(ctx.adapter.getUrl());
          return offer.deal.kind === "pledge" ? pledgeAddress(offer.nonce) : merchantAddress();
        },
        // The price is whatever the signed offer says, and nothing else. The nonce rides along
        // as the tx memo, so a payment can always be found onchain later.
        price: (ctx) => {
          const offer = offerFrom(ctx.adapter.getUrl());
          return { amount: String(offer.deal.price), asset: USDC_DEVNET, extra: { memo: offer.nonce } };
        },
        maxTimeoutSeconds: 120,
      },
      description: "A Lowball item at the price you haggled",
      mimeType: "application/json",
    },
  },
  resourceServer,
);

/** The wallet paying, read from the signed transaction in the payment header. */
function payerOf(req: NextRequest): Address | null {
  const h = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  if (!h) return null;
  try {
    const payload = decodePaymentSignatureHeader(h);
    return address(getTokenPayerFromTransaction(decodeTransactionFromPayload(payload.payload as ExactSvmPayloadV1)));
  } catch {
    return null;
  }
}

function settledOk(res: Response): boolean {
  const h = res.headers.get("PAYMENT-RESPONSE");
  if (!h) return false;
  try {
    return decodePaymentResponseHeader(h).success === true;
  } catch {
    return false;
  }
}

/** Writes the cash receipt, and counts it for the pledge it came through if there is one. */
async function recordCash(offer: Offer, buyer: Address): Promise<void> {
  const auth = await shopSigner();
  const item = SHELF[offer.item];
  const deal = await recordDealIx({ nonce: offer.nonce, item: item.id, buyer, listPrice: item.list, paid: offer.deal.price }, auth);
  const tries: (() => Promise<unknown>)[] = [];
  if (offer.ref) {
    const ref = offer.ref;
    const p = await fetchPledge(ref).catch(() => null);
    if (p) {
      const referral = await recordReferralIx(ref, offer.nonce, auth);
      // The friend who completes the count also releases the vault in the same tx.
      if (p.referred.length + 1 >= p.required) {
        const release = await releaseIx(ref, p.merchant, auth.address);
        tries.push(() => send([deal, referral, release]));
      }
      tries.push(() => send([deal, referral]));
    }
  }
  tries.push(() => send([deal]));
  // The program has the final say on whether a referral counts; if it refuses, the receipt
  // still gets written on its own.
  for (const t of tries) {
    try {
      await t();
      return;
    } catch (e) {
      console.error("recordCash:", (e as Error).message);
    }
  }
}

// A chain hiccup mid-purchase is a "try again", not a crash. Retrying is safe: the chain is
// checked for an existing payment before anything is asked for twice.
export async function GET(req: NextRequest) {
  try {
    return await buy(req);
  } catch (e) {
    console.error("item route:", (e as Error).message);
    if (e instanceof ConfigError) return NextResponse.json({ error: "not_set_up" }, { status: 503 });
    return NextResponse.json({ error: "chain_busy", retry: true }, { status: 503, headers: { "Retry-After": "3" } });
  }
}

async function buy(req: NextRequest) {
  const id = itemIdFrom(req.url);
  if (!SHELF[id]) return NextResponse.json({ error: "no_such_item" }, { status: 404 });
  const check = verifyOffer(req.nextUrl.searchParams.get("offer"), id);
  // Bad, expired and spent offers are turned away before any payment is asked for.
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 410 });
  const { offer } = check;
  const isPledge = offer.deal.kind === "pledge";
  if (isPledge && !offer.deadline) return NextResponse.json({ error: "malformed" }, { status: 410 });

  // Already paid? The chain decides. A cash payment whose receipt never got written (settle
  // timed out, server died) is found by its memo, gets its receipt, and is delivered.
  if (isPledge) {
    const p = await fetchPledge(offer.nonce);
    if (p && (await usdcBalance(await usdcAccount(await pledgeAddress(offer.nonce)))) >= p.price) {
      return NextResponse.json({ error: "offer_used", pledge: `/api/pledge/${offer.nonce}` }, { status: 409 });
    }
  } else {
    if (await dealExists(offer.nonce)) return NextResponse.json({ error: "offer_used" }, { status: 409 });
    const found = await findPaymentByMemo(await usdcAccount(address(merchantAddress())), offer.nonce, offer.deal.price);
    if (found) {
      await recordCash(offer, found.payer);
      return delivered(offer, { recovered: found.signature });
    }
  }

  const payer = payerOf(req);
  if (!payer) return paid(req); // no payment yet: this answers with the 402

  if (inflight.has(offer.nonce)) return NextResponse.json({ error: "payment_in_progress" }, { status: 409 });
  inflight.add(offer.nonce);
  try {
    if (isPledge) {
      // The vault has to exist before the facilitator simulates the transfer into it, so the
      // pledge opens here, with the wallet that's actually paying as its buyer.
      const p = await fetchPledge(offer.nonce);
      if (p && p.buyer !== payer) return NextResponse.json({ error: "offer_used" }, { status: 409 });
      if (!p) {
        const auth = await shopSigner();
        const item = SHELF[id];
        const d = offer.deal as { price: number; referrals: number };
        try {
          await send([await openPledgeIx({
            nonce: offer.nonce, item: id, merchant: address(merchantAddress()), buyer: payer,
            price: d.price, fullPrice: item.list, required: d.referrals, deadline: offer.deadline!,
          }, auth)]);
        } catch (e) {
          console.error("open_pledge:", (e as Error).message);
          return NextResponse.json({ error: "pledge_open_failed" }, { status: 503 });
        }
      }
    }

    const res = await paid(req);
    const ok = settledOk(res);
    if (isPledge && !ok) {
      // Nothing landed, so the empty vault and pledge are closed and the shop gets its rent back.
      // If the transfer did land after all, the program refuses (vault not empty) and the pledge stays.
      try {
        await send([await cancelPledgeIx(offer.nonce, await shopSigner())]);
      } catch (e) {
        console.error("cancel_pledge:", (e as Error).message);
      }
    }
    if (!isPledge && ok) await recordCash(offer, payer);
    return res;
  } finally {
    inflight.delete(offer.nonce);
  }
}
