// Moves devnet USDC from the buyer test wallet to the merchant, which doubles as the
// demo-wallet tap. Usage: npx tsx scripts/refill-tap.mts [usdc=8]
import { address, createKeyPairSignerFromBytes } from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { readFileSync } from "node:fs";
import { send, usdcAccount, usdcBalance } from "../lib/chain.ts";
import { USDC_DEVNET } from "../lib/x402.ts";

const amount = Math.round(Number(process.argv[2] ?? 8) * 1e6);
const key = (n: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`.keys/${n}.json`, "utf8"))));
const [buyer, merchant] = await Promise.all([key("buyer"), key("merchant")]);
const tap = await usdcAccount(merchant.address);
await send([getTransferCheckedInstruction({
  source: await usdcAccount(buyer.address), mint: address(USDC_DEVNET), destination: tap, authority: buyer, amount: BigInt(amount), decimals: 6,
})]);
console.log("tap now", (await usdcBalance(tap)) / 1e6, "USDC");
