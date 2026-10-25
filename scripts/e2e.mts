// End to end on devnet against a running server: cash, pledge, a friend's referral releasing the
// vault, a missed deadline refunded, and a top-up. Offers are signed here, so no LLM is needed.
// Usage: npx tsx --env-file=.env.local scripts/e2e.mts [baseUrl]
// Needs .keys/buyer.json with USDC; creates and funds .keys/friend.json on first run.
import {
  address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createTransactionMessage, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, type KeyPairSigner,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { ed25519 } from "@noble/curves/ed25519.js";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SHELF } from "../lib/catalog.ts";
import { signOffer, type Offer } from "../lib/offer.ts";
import { dealExists, fetchPledge, rpc, usdcAccount, usdcBalance } from "../lib/chain.ts";
import { USDC_DEVNET } from "../lib/x402.ts";

const base = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3000";
// Pass section numbers to run only those, e.g. `e2e.mts 1`.
const only = process.argv.slice(2).filter((a) => /^\d$/.test(a));
const run = (n: string) => only.length === 0 || only.includes(n);
const item = SHELF.overlords;
const USDC = address(USDC_DEVNET);
const key = (n: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`.keys/${n}.json`, "utf8"))));

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`, ok || detail === undefined ? "" : detail);
  if (!ok) failures++;
}

async function sendTx(payer: KeyPairSigner, ixs: Parameters<typeof appendTransactionMessageInstructions>[0]) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const tx = await signTransactionMessageWithSigners(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  ));
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64" }).send();
  const sig = getSignatureFromTransaction(tx);
  for (let i = 0; i < 60; i++) {
    const { value: [st] } = await rpc.getSignatureStatuses([sig]).send();
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("tx not confirmed");
}

// A friend wallet with a few USDC, paid for by the shop (fee + account rent) and the buyer (USDC).
if (!existsSync(".keys/friend.json")) {
  const seed = ed25519.utils.randomSecretKey();
  writeFileSync(".keys/friend.json", JSON.stringify([...seed, ...ed25519.getPublicKey(seed)]));
}
const [shop, buyer, friend, merchant] = await Promise.all([key("shop"), key("buyer"), key("friend"), key("merchant")]);
// Every run pays the merchant, so recycle the merchant's devnet USDC back to the buyer.
const merchantUsdc = await usdcBalance(await usdcAccount(merchant.address));
if (merchantUsdc > 0) {
  await sendTx(shop, [getTransferCheckedInstruction({
    source: await usdcAccount(merchant.address), mint: USDC, destination: await usdcAccount(buyer.address),
    authority: merchant, amount: BigInt(merchantUsdc), decimals: 6,
  })]);
}
console.log("buyer USDC", (await usdcBalance(await usdcAccount(buyer.address))) / 1e6);
const friendAta = await usdcAccount(friend.address);
if ((await usdcBalance(friendAta)) < 2_000_000) {
  await sendTx(shop, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: shop, owner: friend.address, mint: USDC, ata: friendAta }),
    getTransferCheckedInstruction({
      source: await usdcAccount(buyer.address), mint: USDC, destination: friendAta, authority: buyer, amount: BigInt(3_000_000), decimals: 6,
    }),
  ]);
  console.log("funded friend", friend.address);
}

function payer(s: KeyPairSigner) {
  const client = x402Client.fromConfig({
    schemes: [{ network: "solana:*", client: new ExactSvmScheme(toClientSvmSigner(s)) }],
    spendControls: { maxAmountPerPayment: "$5" },
  });
  return wrapFetchWithPayment(fetch, client);
}
const buyerFetch = payer(buyer);
const friendFetch = payer(friend);

const now = () => Math.floor(Date.now() / 1000);
const offer = (deal: Offer["deal"], extra: Partial<Offer> = {}) => {
  const o: Offer = { v: 1, item: item.id, deal, exp: now() + 300, nonce: randomUUID(), ...extra };
  return { o, token: signOffer(o) };
};
const buy = async (f: typeof fetch, token: string) => {
  const res = await f(`${base}/api/item/${item.id}?offer=${token}`);
  const pr = res.headers.get("PAYMENT-REQUIRED");
  const why = res.status === 402 && pr ? decodePaymentRequiredHeader(pr).error : undefined;
  return { status: res.status, body: await res.json().catch(() => ({})), why };
};
const get = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// 1. Cash: paid, receipt onchain, replay refused, claim works.
if (run("1")) {
  const { o, token } = offer({ kind: "cash", price: 1_200_000 });
  const r = await buy(buyerFetch, token);
  check("cash delivered", r.status === 200 && r.body.status === "delivered", r);
  check("cash receipt onchain", await dealExists(o.nonce));
  const again = await buy(buyerFetch, token);
  check("cash replay refused", again.status === 409, again);
  const c = await get(`/api/claim?token=${r.body.claim}`);
  check("cash claim delivers", c.body.status === "delivered", c);
}

// 2 + 3. Pledge for 1 friend; the friend buys through the link and the vault releases.
if (run("2")) {
  const { o, token } = offer({ kind: "pledge", price: 900_000, referrals: 1 }, { deadline: now() + 600 });
  const r = await buy(buyerFetch, token);
  check("pledge accepted", r.status === 200 && r.body.status === "pledged", r);
  const p = await fetchPledge(o.nonce);
  check("pledge onchain, buyer = payer", !!p && p.buyer === buyer.address && p.required === 1, p);
  const s = await get(`/api/pledge/${o.nonce}`);
  check("pledge status open, vault funded", s.body.status === "open" && s.body.paid === 900_000, s);
  const mine = await get(`/api/claim?token=${r.body.claim}`);
  check("pledger claim says pledged", mine.body.status === "pledged", mine);

  const self = offer({ kind: "cash", price: 1_200_000 }, { ref: o.nonce });
  const selfBuy = await buy(buyerFetch, self.token);
  check("pledger's own purchase delivered", selfBuy.status === 200, selfBuy);
  check("but doesn't count for their pledge", (await fetchPledge(o.nonce))?.referred.length === 0);

  const fr = offer({ kind: "cash", price: 1_200_000 }, { ref: o.nonce });
  const f = await buy(friendFetch, fr.token);
  check("friend delivered", f.status === 200, f);
  const after = await get(`/api/pledge/${o.nonce}`);
  check("pledge released by the friend's purchase", after.body.status === "released", after);
  const claimed = await get(`/api/claim?token=${r.body.claim}`);
  check("pledger claim now delivers", claimed.body.status === "delivered", claimed);
}

// 4. Missed deadline, refund.
if (run("4")) {
  const { o, token } = offer({ kind: "pledge", price: 500_000, referrals: 2 }, { deadline: now() + 25 });
  const before = await usdcBalance(await usdcAccount(buyer.address));
  const r = await buy(buyerFetch, token);
  check("short pledge accepted", r.status === 200, r);
  const early = await get(`/api/pledge/${o.nonce}`, { method: "POST" });
  check("refund refused before the deadline", early.status === 409, early);
  while (now() < o.deadline! + 3) await new Promise((res) => setTimeout(res, 2000));
  const s = await get(`/api/pledge/${o.nonce}`);
  check("status says missed", s.body.status === "missed", s);
  const ref = await get(`/api/pledge/${o.nonce}`, { method: "POST" });
  check("refunded", ref.body.status === "refunded", ref);
  check("buyer got it all back", (await usdcBalance(await usdcAccount(buyer.address))) === before);
  const gone = await get(`/api/pledge/${o.nonce}`);
  check("status reads refunded from history", gone.body.status === "refunded", gone);
}

// 5. Top-up: pay the gap and the item releases.
if (run("5")) {
  const { o, token } = offer({ kind: "pledge", price: 700_000, referrals: 3 }, { deadline: now() + 600 });
  const r = await buy(buyerFetch, token);
  check("pledge for top-up accepted", r.status === 200, r);
  const res = await buyerFetch(`${base}/api/pledge/${o.nonce}/topup`);
  const t = { status: res.status, body: await res.json().catch(() => ({})) };
  check("top-up paid", t.status === 200 && t.body.status === "topped_up", t);
  const s = await get(`/api/pledge/${o.nonce}`);
  check("topped-up pledge released", s.body.status === "released", s);
  const claimed = await get(`/api/claim?token=${r.body.claim}`);
  check("claim delivers after top-up", claimed.body.status === "delivered", claimed);
}

// 6. A cent with the right memo is not a payment: recovery checks the amount, not just the memo.
if (run("6")) {
  const { o, token } = offer({ kind: "cash", price: 1_200_000 });
  await sendTx(shop, [
    getTransferCheckedInstruction({
      source: await usdcAccount(buyer.address), mint: USDC, destination: await usdcAccount(address(process.env.MERCHANT_ADDRESS!)),
      authority: buyer, amount: BigInt(10_000), decimals: 6,
    }),
    { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: new TextEncoder().encode(o.nonce) },
  ]);
  const r = await get(`/api/item/${item.id}?offer=${token}`);
  check("a cent with the memo gets a 402, not the item", r.status === 402, r);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
