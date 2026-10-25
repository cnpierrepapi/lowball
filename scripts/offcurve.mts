// Spike: does the x402.org facilitator settle a payment whose payTo is a PDA (off-curve)?
// The pledge design pays straight into a vault owned by the pledge PDA, so this has to work.
// Pays 0.01 USDC from the buyer into the USDC account of a throwaway PDA. That cent is stuck
// for good, since no deployed program can sign for the PDA.
// Usage: npx tsx scripts/offcurve.mts
import {
  address, appendTransactionMessageInstruction, createKeyPairSignerFromBytes, createSolanaRpc,
  createSolanaRpcSubscriptions, createTransactionMessage, getProgramDerivedAddress,
  pipe, sendAndConfirmTransactionFactory, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { SOLANA_DEVNET, USDC_DEVNET } from "../lib/x402.ts";

const PROGRAM = address("AjbVvJWBTYy1685BRoythenR22ruYvPjbT2KYqcbKJh5");
const USDC = address(USDC_DEVNET);
const key = (n: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`.keys/${n}.json`, "utf8"))));
const rpc = createSolanaRpc("https://api.devnet.solana.com");
const subs = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");

// Same seed shape as a real pledge: ["pledge", nonce].
const nonce = randomBytes(16);
const [pda] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["pledge", nonce] });
console.log("pda (off-curve by construction)", pda);
const [vault] = await findAssociatedTokenPda({ owner: pda, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });

// open_pledge creates the vault before settle, so the spike does the same.
const shop = await key("shop");
const { value: blockhash } = await rpc.getLatestBlockhash().send();
const msg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(shop, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => appendTransactionMessageInstruction(
    getCreateAssociatedTokenIdempotentInstruction({ payer: shop, owner: pda, mint: USDC, ata: vault }), m),
);
await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs })(
  (await signTransactionMessageWithSigners(msg)) as never, { commitment: "confirmed" });
console.log("vault", vault, "created");

const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const supported = await facilitator.getSupported();
const kind = supported.kinds.find((k) => k.network === SOLANA_DEVNET && k.scheme === "exact" && k.x402Version === 2);
if (!kind) throw new Error("facilitator has no exact scheme on solana devnet");

const requirements = {
  scheme: "exact", network: SOLANA_DEVNET, asset: USDC_DEVNET, amount: "10000", payTo: pda,
  maxTimeoutSeconds: 120, extra: { ...kind.extra, memo: nonce.toString("hex") },
};
const buyer = toClientSvmSigner(await key("buyer"));
const client = x402Client.fromConfig({ schemes: [{ network: "solana:*", client: new ExactSvmScheme(buyer) }] });
const payload = await client.createPaymentPayload({
  x402Version: 2, resource: { url: "https://lowball.local/spike", description: "off-curve spike", mimeType: "application/json" },
  accepts: [requirements],
});

const v = await facilitator.verify(payload, requirements);
console.log("verify", v);
if (!v.isValid) process.exit(1);
const s = await facilitator.settle(payload, requirements);
console.log("settle", s);

const bal = await rpc.getTokenAccountBalance(vault).send();
console.log("vault balance", bal.value.uiAmountString, "USDC");
