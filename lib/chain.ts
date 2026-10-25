import {
  AccountRole, address, appendTransactionMessageInstructions, createDefaultRpcTransport, createKeyPairSignerFromBytes,
  createSolanaRpcFromTransport, isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, type RpcTransport,
  createTransactionMessage, getAddressDecoder, getAddressEncoder, getBase64EncodedWireTransaction, getProgramDerivedAddress,
  getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction, type KeyPairSigner,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { USDC_DEVNET } from "./x402";

// Thin client for the Lowball program, written against @solana/kit so the app doesn't pull in
// Anchor. Layouts mirror anchor/programs/lowball/src/lib.rs; change both together.
export const PROGRAM_ID = address(process.env.LOWBALL_PROGRAM_ID ?? "AjbVvJWBTYy1685BRoythenR22ruYvPjbT2KYqcbKJh5");
const MINT = address(USDC_DEVNET);
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

// The public devnet RPC rate-limits hard (429). Retry those with backoff instead of failing a
// purchase halfway; anything else fails at once.
const http = createDefaultRpcTransport({ url: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com" });
const transport: RpcTransport = async (req) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await http(req);
    } catch (e) {
      const limited = isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && e.context.statusCode === 429;
      if (!limited || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
};
export const rpc = createSolanaRpcFromTransport(transport);

const sha = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8);
const ix = (name: string) => sha(`global:${name}`);
const ACCOUNT_PLEDGE = sha("account:Pledge");
const ACCOUNT_DEAL = sha("account:Deal");

const addrEnc = getAddressEncoder();
const addr = { encode: (a: Address) => Buffer.from(addrEnc.encode(a)) };
const u64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

/** Offer nonces are UUIDs; onchain they're the 16 raw bytes. */
export function nonceBytes(uuid: string): Buffer {
  const h = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(h)) throw new Error("nonce is not a uuid");
  return Buffer.from(h, "hex");
}

/** Item ids are stored as utf8, zero-padded to 32 bytes (same as the program tests). */
export function itemBytes(id: string): Buffer {
  const b = Buffer.alloc(32);
  if (b.write(id) !== Buffer.byteLength(id)) throw new Error("item id longer than 32 bytes");
  return b;
}

const pda = async (seeds: (string | Uint8Array)[]) =>
  (await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds }))[0];
export const shopAddress = () => pda(["shop"]);
export const pledgeAddress = (nonce: string) => pda(["pledge", nonceBytes(nonce)]);
export const dealAddress = (nonce: string) => pda(["deal", nonceBytes(nonce)]);
export const usdcAccount = async (owner: Address) =>
  (await findAssociatedTokenPda({ owner, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

let signer: Promise<KeyPairSigner> | undefined;
/** The shop authority. SHOP_KEYPAIR is the 64-byte keypair as a JSON array; dev falls back to .keys/shop.json. */
export function shopSigner(): Promise<KeyPairSigner> {
  signer ??= (() => {
    const raw = process.env.SHOP_KEYPAIR ??
      (process.env.NODE_ENV !== "production" ? readFileSync(".keys/shop.json", "utf8") : undefined);
    if (!raw) throw new Error("SHOP_KEYPAIR is not set");
    return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(raw)));
  })();
  return signer;
}

const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
const r = (a: Address) => ({ address: a, role: AccountRole.READONLY });
const ws = (s: KeyPairSigner) => ({ address: s.address, role: AccountRole.WRITABLE_SIGNER, signer: s });
const rs = (s: KeyPairSigner) => ({ address: s.address, role: AccountRole.READONLY_SIGNER, signer: s });

export interface PledgeTerms {
  nonce: string;
  item: string;
  merchant: Address;
  buyer: Address;
  price: number;
  fullPrice: number;
  required: number;
  deadline: number;
}

export async function openPledgeIx(t: PledgeTerms, auth: KeyPairSigner): Promise<Instruction> {
  const pledge = await pledgeAddress(t.nonce);
  return {
    programAddress: PROGRAM_ID,
    accounts: [r(await shopAddress()), w(pledge), r(MINT), w(await usdcAccount(pledge)), ws(auth),
      r(TOKEN_PROGRAM_ADDRESS), r(ATA_PROGRAM), r(SYSTEM_PROGRAM)],
    data: Buffer.concat([ix("open_pledge"), nonceBytes(t.nonce), itemBytes(t.item), addr.encode(t.merchant),
      addr.encode(t.buyer), u64(t.price), u64(t.fullPrice), Buffer.from([t.required]), i64(t.deadline)]),
  };
}

export async function cancelPledgeIx(nonce: string, auth: KeyPairSigner): Promise<Instruction> {
  const pledge = await pledgeAddress(nonce);
  return {
    programAddress: PROGRAM_ID,
    accounts: [r(await shopAddress()), w(pledge), w(await usdcAccount(pledge)), ws(auth), r(TOKEN_PROGRAM_ADDRESS)],
    data: ix("cancel_pledge"),
  };
}

export interface DealTerms { nonce: string; item: string; buyer: Address; listPrice: number; paid: number }

export async function recordDealIx(d: DealTerms, auth: KeyPairSigner): Promise<Instruction> {
  return {
    programAddress: PROGRAM_ID,
    accounts: [r(await shopAddress()), w(await dealAddress(d.nonce)), ws(auth), r(SYSTEM_PROGRAM)],
    data: Buffer.concat([ix("record_deal"), nonceBytes(d.nonce), itemBytes(d.item), addr.encode(d.buyer),
      u64(d.listPrice), u64(d.paid)]),
  };
}

export async function recordReferralIx(pledgeNonce: string, dealNonce: string, auth: KeyPairSigner): Promise<Instruction> {
  const pledge = await pledgeAddress(pledgeNonce);
  return {
    programAddress: PROGRAM_ID,
    accounts: [r(await shopAddress()), w(pledge), r(await usdcAccount(pledge)), w(await dealAddress(dealNonce)), rs(auth)],
    data: ix("record_referral"),
  };
}

/** Release and refund are permissionless; the shop just pays the fee. */
export async function releaseIx(nonce: string, merchant: Address, rentTo: Address): Promise<Instruction> {
  const pledge = await pledgeAddress(nonce);
  return {
    programAddress: PROGRAM_ID,
    accounts: [r(await shopAddress()), w(pledge), w(await usdcAccount(pledge)), w(await usdcAccount(merchant)),
      w(rentTo), r(TOKEN_PROGRAM_ADDRESS)],
    data: ix("release"),
  };
}

export async function refundIx(nonce: string, buyer: Address, rentTo: Address): Promise<Instruction> {
  const pledge = await pledgeAddress(nonce);
  return {
    programAddress: PROGRAM_ID,
    accounts: [r(await shopAddress()), w(pledge), w(await usdcAccount(pledge)), w(await usdcAccount(buyer)),
      w(rentTo), r(TOKEN_PROGRAM_ADDRESS)],
    data: ix("refund"),
  };
}

/** Sends instructions signed by the shop and waits for "confirmed". Polls, so no websocket is needed. */
export async function send(ixs: Instruction[], timeoutMs = 45_000): Promise<string> {
  const auth = await shopSigner();
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(auth, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  // Preflight runs a simulation, so a program error comes back here with its logs.
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { value: [st] } = await rpc.getSignatureStatuses([sig]).send();
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err, (_, v) => typeof v === "bigint" ? Number(v) : v)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await new Promise((res) => setTimeout(res, 800));
  }
  throw new Error(`tx ${sig} not confirmed in ${timeoutMs} ms`);
}

async function accountData(a: Address): Promise<Buffer | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: "base64", commitment: "confirmed" }).send();
  if (!value || value.owner !== PROGRAM_ID) return null;
  return Buffer.from(value.data[0], "base64");
}

export interface PledgeAccount {
  merchant: Address;
  buyer: Address;
  price: number;
  fullPrice: number;
  required: number;
  deadline: number;
  referred: Address[];
}

const readAddr = (b: Buffer, o: number) => getAddressDecoder().decode(b.subarray(o, o + 32));

export async function fetchPledge(nonce: string): Promise<PledgeAccount | null> {
  const b = await accountData(await pledgeAddress(nonce));
  if (!b || !b.subarray(0, 8).equals(ACCOUNT_PLEDGE)) return null;
  // disc 8 | nonce 16 | item 32 | merchant 32 | buyer 32 | price 8 | full 8 | required 1 | deadline 8 | slot 8 | vec
  let o = 8 + 16 + 32;
  const merchant = readAddr(b, o); o += 32;
  const buyer = readAddr(b, o); o += 32;
  const price = Number(b.readBigUInt64LE(o)); o += 8;
  const fullPrice = Number(b.readBigUInt64LE(o)); o += 8;
  const required = b[o]; o += 1;
  const deadline = Number(b.readBigInt64LE(o)); o += 8 + 8;
  const n = b.readUInt32LE(o); o += 4;
  const referred = Array.from({ length: n }, (_, i) => readAddr(b, o + 32 * i));
  return { merchant, buyer, price, fullPrice, required, deadline, referred };
}

export async function dealExists(nonce: string): Promise<boolean> {
  const b = await accountData(await dealAddress(nonce));
  return !!b && b.subarray(0, 8).equals(ACCOUNT_DEAL);
}

/** USDC in an account, in micro units; 0 if the account doesn't exist. */
export async function usdcBalance(tokenAccount: Address): Promise<number> {
  try {
    const { value } = await rpc.getTokenAccountBalance(tokenAccount, { commitment: "confirmed" }).send();
    return Number(value.amount);
  } catch {
    return 0;
  }
}

/** How a pledge that's no longer onchain ended, read from its address history. */
export async function pledgeOutcome(nonce: string): Promise<"released" | "refunded" | "cancelled" | "unknown"> {
  const sigs = await rpc.getSignaturesForAddress(await pledgeAddress(nonce), { limit: 20, commitment: "confirmed" }).send();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }).send();
    const logs = tx?.meta?.logMessages ?? [];
    if (logs.some((l) => l.includes("Instruction: Release"))) return "released";
    if (logs.some((l) => l.includes("Instruction: Refund"))) return "refunded";
    if (logs.some((l) => l.includes("Instruction: CancelPledge"))) return "cancelled";
  }
  return "unknown";
}

/**
 * Finds a settled payment into `tokenAccount` carrying exactly this memo and at least `minAmount`
 * of USDC. The memo alone proves nothing (anyone can send a cent with any memo), so the transfer
 * itself is checked. This is how a payment whose settle response got lost is still honoured.
 */
export async function findPaymentByMemo(
  tokenAccount: Address, memo: string, minAmount: number,
): Promise<{ signature: string; payer: Address } | null> {
  const sigs = await rpc.getSignaturesForAddress(tokenAccount, { limit: 100, commitment: "confirmed" }).send();
  // The RPC joins memos as "[len] text; [len] text".
  const hasMemo = (m: string | null) => !!m && m.split("; ").some((part) => part.replace(/^\[\d+\] /, "") === memo);
  for (const s of sigs) {
    if (s.err || !hasMemo(s.memo)) continue;
    const tx = await rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "jsonParsed" }).send();
    const ixs = (tx?.transaction.message.instructions ?? []) as unknown as {
      program?: string; parsed?: { type?: string; info?: { destination?: string; mint?: string; authority?: string; tokenAmount?: { amount?: string } } };
    }[];
    for (const i of ixs) {
      const info = i.parsed?.info;
      if (i.program !== "spl-token" || i.parsed?.type !== "transferChecked" || !info) continue;
      if (info.destination !== tokenAccount || info.mint !== MINT || !info.authority) continue;
      if (Number(info.tokenAmount?.amount ?? 0) >= minAmount) return { signature: s.signature, payer: address(info.authority) };
    }
  }
  return null;
}
