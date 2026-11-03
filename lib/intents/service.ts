import { address } from "@solana/kit";
import { db } from "../db";
import { shopStore } from "../shop/store";
import { merchantAddress } from "../x402";
import { dealExists, recordDealIx, send, shopSigner } from "../chain";
import { itemById } from "../catalog";
import { rpcCall } from "../research/chain";
import { USDC_MINT, payOptions, type Fetch, type Token } from "./api";
import type { PayDeps } from "./pay";

// Aurora Intents wired to the real database, the shop's address and the chain. The API key lives
// in the back office (settings: intents_api_key). Aurora's docs say it isn't secret.

export async function intentsKey(): Promise<string | undefined> {
  const d = db();
  return d ? (await shopStore(d).setting("intents_api_key")) || undefined : undefined;
}

/** The receipt, written exactly like an x402 sale. The buyer is named when they refunded to Solana. */
async function writeReceipt(p: { nonce: string; item: string; price: number; payer: string | null }): Promise<boolean> {
  if (await dealExists(p.nonce)) return true;
  const item = await itemById(p.item);
  if (!item) throw new Error("no such item");
  const auth = await shopSigner();
  await send([await recordDealIx({ nonce: p.nonce, item: p.item, buyer: address(p.payer ?? auth.address), listPrice: item.list, paid: p.price }, auth)]);
  return dealExists(p.nonce);
}

export async function liveDeps(): Promise<PayDeps | undefined> {
  const d = db();
  const apiKey = await intentsKey();
  if (!d || !apiKey) return undefined;
  return { db: d, apiKey, merchant: merchantAddress(), writeReceipt };
}

let cached: { at: number; tokens: Token[] } | undefined;
/** What buyers can pay with, cached for 10 minutes. */
export async function options(f: Fetch = fetch): Promise<Token[]> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.tokens;
  const tokens = await payOptions((await intentsKey()) ?? "public", f);
  cached = { at: Date.now(), tokens };
  return tokens;
}

/** Does the shop's address hold a USDC account on Solana mainnet (where Aurora delivers)? */
export async function shopHasMainnetUsdc(): Promise<boolean | "unknown"> {
  try {
    const r = await rpcCall<{ value: unknown[] }>(
      "getTokenAccountsByOwner",
      [merchantAddress(), { mint: USDC_MINT }, { encoding: "jsonParsed" }],
    );
    return r.value.length > 0;
  } catch {
    return "unknown";
  }
}
