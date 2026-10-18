// Creates the devnet USDC token account for a .keys/ wallet (idempotent, the wallet pays rent).
// Usage: npx tsx scripts/ata.mts merchant
import {
  appendTransactionMessageInstruction, createKeyPairSignerFromBytes, createSolanaRpc,
  createSolanaRpcSubscriptions, createTransactionMessage, getSignatureFromTransaction, address,
  pipe, sendAndConfirmTransactionFactory, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import { readFileSync } from "node:fs";

const USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const name = process.argv[2] ?? "merchant";
const owner = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`.keys/${name}.json`, "utf8"))));
const rpc = createSolanaRpc("https://api.devnet.solana.com");
const subs = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");

const [ata] = await findAssociatedTokenPda({ owner: owner.address, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
const { value: blockhash } = await rpc.getLatestBlockhash().send();
const msg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(owner, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => appendTransactionMessageInstruction(
    getCreateAssociatedTokenIdempotentInstruction({ payer: owner, owner: owner.address, mint: USDC, ata }), m),
);
const tx = await signTransactionMessageWithSigners(msg);
await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs })(tx as never, { commitment: "confirmed" });
console.log(`${name} USDC account ${ata}, tx ${getSignatureFromTransaction(tx)}`);
