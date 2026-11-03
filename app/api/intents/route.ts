import { connection, NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/lib/limits";
import { verifyOffer } from "@/lib/offer";
import { claimFor } from "@/lib/claim";
import { dealExists } from "@/lib/chain";
import { itemById } from "@/lib/catalog";
import { checkIntent, startIntent } from "@/lib/intents/pay";
import { intentsKey, liveDeps, options } from "@/lib/intents/service";
import { ConfigError } from "@/lib/config";

// Paying with any crypto through Aurora Intents (real money). The x402 route is untouched; this
// is a second way to pay the same signed offer.
//   GET                          what buyers can pay with
//   POST { action: "start" }     a one-time deposit address for the offer's exact price
//   POST { action: "status" }    how the payment is going; on success, the claim to read the pack

export const maxDuration = 60;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET() {
  await connection(); // per request: the list comes from Aurora, never baked in at build
  try {
    // No key saved yet: the button stays hidden.
    if (!(await intentsKey())) return json({ enabled: false, tokens: [] });
    const tokens = await options();
    return json({ enabled: true, tokens: tokens.map((t) => ({ assetId: t.assetId, symbol: t.symbol, chain: t.blockchain, price: t.price })) });
  } catch (e) {
    console.error("intents options:", (e as Error).message);
    return json({ error: "intents_down" }, 503);
  }
}

export async function POST(req: NextRequest) {
  if (!allow(`intents:${clientIp(req)}`, 20, 60_000)) return json({ error: "slow_down" }, 429);
  const body = await req.json().catch(() => ({}));
  try {
    const deps = await liveDeps();
    if (!deps) return json({ error: "intents_off" }, 503);

    if (body.action === "start") {
      const item = await itemById(String(body.item ?? ""));
      if (!item) return json({ error: "no_such_item" }, 404);
      // The price comes from the signed offer and nothing else, exactly as on the x402 route.
      const check = verifyOffer(typeof body.offer === "string" ? body.offer : null, item.id);
      if (!check.ok) return json({ error: check.reason }, 410);
      const { offer } = check;
      if (offer.deal.kind !== "cash") return json({ error: "cash_only" }, 400);
      if (await dealExists(offer.nonce)) return json({ error: "offer_used" }, 409);
      const refundTo = String(body.refundTo ?? "").trim();
      if (!refundTo || refundTo.length > 128 || /\s/.test(refundTo)) return json({ error: "bad_refund_address" }, 400);
      const tokens = await options();
      const token = tokens.find((t) => t.assetId === body.originAsset);
      if (!token) return json({ error: "bad_token" }, 400);
      const r = await startIntent(deps, {
        nonce: offer.nonce, item: item.id, price: offer.deal.price, originAsset: token.assetId, refundTo, dropHold: item.kind === "pack",
      });
      return json({
        nonce: r.nonce, depositAddress: r.depositAddress, depositMemo: r.depositMemo, amount: r.amountInText,
        symbol: token.symbol, chain: token.blockchain, deadline: r.deadline, status: r.status,
      });
    }

    if (body.action === "status") {
      const nonce = String(body.nonce ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(nonce)) return json({ error: "no_payment" }, 404);
      const c = await checkIntent(deps, nonce);
      if (!c) return json({ error: "no_payment" }, 404);
      const claim = c.paid ? claimFor({ v: 1, item: c.row.item, deal: { kind: "cash", price: c.row.price }, exp: 0, nonce }) : undefined;
      return json({ status: c.row.status, paid: c.paid, claim });
    }

    return json({ error: "generic" }, 400);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "copy_gone") return json({ error: "sold_out" }, 410);
    console.error("intents:", msg);
    if (e instanceof ConfigError) return json({ error: "not_set_up" }, 503);
    return json({ error: "intents_down", detail: msg.slice(0, 200) }, 502);
  }
}
