// Spike: haggle a deal with the real engine, sign the offer, then pay for it over x402 on devnet.
// Usage: npx tsx --env-file=.env.local scripts/pay.mts [baseUrl] [expire]
//   expire: sign an already-expired offer to check the failure path.
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SHELF } from "../lib/catalog.ts";
import { openState, step } from "../lib/engine/negotiate.ts";
import { formatUsdc } from "../lib/engine/money.ts";
import { signOffer } from "../lib/offer.ts";

const base = process.argv[2] ?? "http://localhost:3000";
const expired = process.argv.includes("expire");

const item = SHELF.overlords;
let s = openState(item);
for (const amount of [0.6, 0.9, 1.1, 1.3]) {
  const r = step(item, s, { kind: "offer", tone: "polite", amount });
  s = r.state;
  console.log(`offer ${amount} -> ${r.decision.action} ask ${formatUsdc(s.ask)}`);
  if (s.status !== "open") break;
}
if (!s.deal) s = step(item, s, { kind: "accept", tone: "neutral" }).state;
console.log("deal:", s.deal, `= ${formatUsdc(s.deal!.price)} USDC`);

const token = signOffer({
  v: 1,
  item: item.id,
  deal: s.deal!,
  exp: Math.floor(Date.now() / 1000) + (expired ? -5 : 300),
  nonce: randomUUID(),
});

const bytes = new Uint8Array(JSON.parse(readFileSync(".keys/buyer.json", "utf8")));
const signer = toClientSvmSigner(await createKeyPairSignerFromBytes(bytes));
const client = x402Client.fromConfig({
  schemes: [{ network: "solana:*", client: new ExactSvmScheme(signer) }],
  spendControls: { maxAmountPerPayment: "$5" },
});
const paidFetch = wrapFetchWithPayment(fetch, client);

const url = `${base}/api/item/${item.id}?offer=${token}`;
const res = await paidFetch(url);
console.log("status", res.status, await res.text());
const pr = res.headers.get("PAYMENT-RESPONSE");
if (pr) console.log("settlement", decodePaymentResponseHeader(pr));
