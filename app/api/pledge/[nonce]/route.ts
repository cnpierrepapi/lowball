import { NextRequest, NextResponse } from "next/server";
import {
  fetchPledge, pledgeAddress, pledgeOutcome, refundIx, releaseIx, send, shopSigner, usdcAccount, usdcBalance,
} from "@/lib/chain";

// Public progress for a pledge, for the share page and the pledger's own screen. Nothing here
// hands out the item; that takes the pledger's claim token (/api/claim).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// After the deadline the buyer picks: top up the gap or take a refund. Past the grace period
// the shop refunds on its own, so no money sits in a vault forever.
const GRACE = Number(process.env.PLEDGE_GRACE_SECONDS ?? 24 * 60 * 60);

function nonceFrom(req: NextRequest): string | null {
  const n = req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
  return UUID.test(n) ? n : null;
}

async function status(nonce: string) {
  const p = await fetchPledge(nonce);
  if (!p) return { nonce, status: await pledgeOutcome(nonce) };
  const vault = await usdcBalance(await usdcAccount(await pledgeAddress(nonce)));
  const now = Math.floor(Date.now() / 1000);
  const ready = (p.referred.length >= p.required && vault >= p.price) || vault >= p.fullPrice;
  return {
    nonce,
    status: ready ? "ready" : now < p.deadline ? "open" : "missed",
    paid: vault,
    price: p.price,
    fullPrice: p.fullPrice,
    required: p.required,
    count: p.referred.length,
    deadline: p.deadline,
    topUp: Math.max(0, p.fullPrice - vault),
    buyer: p.buyer,
    merchant: p.merchant,
  };
}

async function refund(nonce: string, buyer: string) {
  const auth = await shopSigner();
  return send([await refundIx(nonce, buyer as never, auth.address)]);
}

export async function GET(req: NextRequest) {
  const nonce = nonceFrom(req);
  if (!nonce) return NextResponse.json({ error: "bad_nonce" }, { status: 400 });
  const s = await status(nonce);
  // Normally the friend who completes the count releases the vault in the same tx. If that
  // part failed, whoever looks next finishes the job.
  if (s.status === "ready") {
    try {
      const auth = await shopSigner();
      await send([await releaseIx(nonce, s.merchant as never, auth.address)]);
      return NextResponse.json({ nonce, status: "released" });
    } catch (e) {
      console.error("release:", (e as Error).message);
    }
  }
  if (s.status === "missed" && "deadline" in s && Date.now() / 1000 >= s.deadline! + GRACE) {
    try {
      await refund(nonce, s.buyer!);
      return NextResponse.json({ nonce, status: "refunded" });
    } catch (e) {
      console.error("auto refund:", (e as Error).message);
    }
  }
  return NextResponse.json(s);
}

// Refund is permissionless onchain once the deadline passes, so anyone may ask for it; the
// money only ever goes back to the pledger.
export async function POST(req: NextRequest) {
  const nonce = nonceFrom(req);
  if (!nonce) return NextResponse.json({ error: "bad_nonce" }, { status: 400 });
  const s = await status(nonce);
  if (s.status !== "missed") return NextResponse.json({ error: "not_refundable", ...s }, { status: 409 });
  try {
    const tx = await refund(nonce, s.buyer!);
    return NextResponse.json({ nonce, status: "refunded", tx });
  } catch (e) {
    console.error("refund:", (e as Error).message);
    return NextResponse.json({ error: "refund_failed" }, { status: 503 });
  }
}
