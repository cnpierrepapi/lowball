import { connection, NextResponse } from "next/server";
import { address, getAddressDecoder } from "@solana/kit";
import { offerPublicKey } from "@/lib/offer";
import { merchantAddress } from "@/lib/x402";
import { vertexReady } from "@/lib/vertex";
import { PROGRAM_ID, rpc, shopAddress, shopSigner, usdcAccount } from "@/lib/chain";

// Everything the shop needs to take money, checked for real. Any failure is a 503, so a
// misconfigured deploy shows up here instead of as a shopkeeper who never deals.
// No model calls: the Vertex check only mints a token.

async function check(fn: () => Promise<unknown> | unknown): Promise<true | string> {
  try {
    await fn();
    return true;
  } catch (e) {
    return (e as Error).message.slice(0, 200);
  }
}

export async function GET() {
  await connection(); // per request, never prerendered at build
  const checks = {
    offerKey: await check(() => offerPublicKey()),
    merchant: await check(async () => {
      const { value } = await rpc.getAccountInfo(await usdcAccount(address(merchantAddress())), { encoding: "base64" }).send();
      if (!value) throw new Error("merchant has no USDC account");
    }),
    program: await check(async () => {
      const { value } = await rpc.getAccountInfo(PROGRAM_ID, { encoding: "base64" }).send();
      if (!value?.executable) throw new Error(`program ${PROGRAM_ID} not deployed on this cluster`);
    }),
    shop: await check(async () => {
      const { value } = await rpc.getAccountInfo(await shopAddress(), { encoding: "base64" }).send();
      if (!value) throw new Error("shop not initialised");
      // Shop layout: disc 8 | authority 32 | mint 32 | bump 1
      const authority = getAddressDecoder().decode(Buffer.from(value.data[0], "base64").subarray(8, 40));
      if (authority !== (await shopSigner()).address) throw new Error("SHOP_KEYPAIR is not the shop authority");
    }),
    shopSol: await check(async () => {
      const { value } = await rpc.getBalance((await shopSigner()).address).send();
      // Each pledge fronts ~0.006 SOL of rent until it closes.
      if (value < BigInt(50_000_000)) throw new Error(`shop authority low on SOL: ${Number(value) / 1e9}`);
    }),
    vertex: await check(() => vertexReady()),
  };
  const ok = Object.values(checks).every((c) => c === true);
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
